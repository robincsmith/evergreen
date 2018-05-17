/*
 * This is the main entrypoint for the evergreen-client
 */

const path    = require('path');
const process = require('process');

const feathers = require('@feathersjs/feathers');
const fetch    = require('node-fetch');
const logger   = require('winston');
const rest     = require('@feathersjs/rest-client');

const createCron     = require('./lib/periodic');
const Downloader     = require('./lib/downloader');
const ErrorTelemetry = require('./lib/error-telemetry');
const Registration   = require('./lib/registration');
const Status         = require('./lib/status');
const Supervisord    = require('./lib/supervisord');
const Update         = require('./lib/update');

/*
 * The Client class is a simple wrapper meant to start the basics of the client
 * and then run a simple runloop to block the client from ever exiting
 */
class Client {
  constructor() {
    this.app = feathers();
    this.reg = new Registration(this.app);
    this.status = new Status(this.app);
    this.update = new Update(this.app);
    this.errorTelemetry = new ErrorTelemetry(this.app);
  }

  async runUpdates() {
    return this.update.query().then((ups) => {
      if (process.env.EVERGREEN_OFFLINE) {
        logger.info('Evergreen in offline mode, disabling downloading of updates..');
        return;
      }

      if (ups) {
        logger.info('Updates available', ups);
        let tasks = [];

        const dir = path.join(process.env.EVERGREEN_HOME,
          'jenkins',
          'home');

        if (ups.core.url) {
          tasks.push(Downloader.download(ups.core.url, dir).then((stream) => {
            logger.info('Core downloaded', stream.path);
          }));
        }

        ups.plugins.updates.forEach((plugin) => {
          logger.info('Fetching ', plugin.url);
          tasks.push(Downloader.download(plugin.url, path.join(dir, 'plugins')).then((stream) => {
            logger.info('download complete', stream.path);
          }));
        });

        Promise.all(tasks).then(() => {
          logger.info('All downloads completed, restarting Jenkins');
          this.update.saveUpdateSync(ups);
          Supervisord.restartProcess('jenkins');
        });
      }
    }).catch((res) => logger.info('No updates available', res));
  }

  runloop(app) {
    logger.info('..starting runloop');
    /*
     * Only setting on the cron once we have registered and logged in,
     * otherwise it's not really useful to have anything running periodically
     */
    const cron = createCron(app);

    this.runUpdates();

    cron.runHourly('post-status', () => {
      // TODO: update status
    });
    cron.runDaily('check-for-updates', () => {
      this.runUpdates();
    });

    setInterval( () => {
      /* no-op to keep this process alive */
    }, 10);
  }

  bootstrap() {
    const endpoint = process.env.EVERGREEN_ENDPOINT;
    const restClient = rest(endpoint);

    logger.info('Configuring the client to use the endpoint %s', endpoint);
    this.app.configure(restClient.fetch(fetch));

    // FIXME: move this into runloop once we figure out how to run it locally during testing
    try {
      this.errorTelemetry.setup();
    }
    catch (err) {
      logger.error('Failed to set up Error Telemetry', err);
    }
    // END FIXME

    this.reg.register().then((res, newRegistration) => {
      logger.debug('Registration returned', res);
      this.status.authenticate(this.reg.uuid, this.reg.token);
      this.update.authenticate(this.reg.uuid, this.reg.token);
      /*
       * It is only valid to start the runloop assuming we have been able to
       * register and log in successfully, otherwise the client will exit and
       * supervisord should try again :/
       */
      if (newRegistration) {
        return this.status.create().then(() => {
          this.runloop(this.app);
        });
      }
      else {
        return this.runloop(this.app);
      }
    }).catch((err) => {
      logger.info('Fatal error encountered while trying to register, exiting the client and will restart and retry', err);
      process.exit(1);
    });
  }
}

module.exports = Client;

if (require.main === module) {
  /* Main entrypoint for module */
  logger.info('Starting the evergreen-client..');
  let client = new Client();
  client.bootstrap();
}