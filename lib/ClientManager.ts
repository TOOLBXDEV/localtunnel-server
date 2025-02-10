import Debug from 'debug';
import Client from './Client';
import TunnelAgent from './TunnelAgent';

const logger = {
  debug: Debug('lt:ClientManager:debug'),
  info: Debug('lt:ClientManager:info'),
  error: Debug('lt:ClientManager:error'),
};

// Manage sets of clients
//
// A client is a "user session" established to service a remote localtunnel client
class ClientManager {
  constructor(opt) {
    this.opt = opt || {};

    // id -> client instance
    this.clients = new Map();

    // statistics
    this.stats = {
      tunnels: 0,
    };

    // This is totally wrong :facepalm: this needs to be per-client...
    this.graceTimeout = null;
  }

  // create a new tunnel with `id`
  // if the id is already used, a random id is assigned
  // if the tunnel could not be created, throws an error
  async newClient(id) {
    const clients = this.clients;
    const stats = this.stats;

    // can't ask for id already is use
    if (clients[id]) {
      logger.info(
        `Client with id "${id}" already exists. Removing old client and creating new one.`
      );
      this.removeClient(id);
    }

    const maxSockets = this.opt.max_tcp_sockets;
    const agent = new TunnelAgent({
      clientId: id,
      maxSockets: 10,
    });

    const client = new Client({
      id,
      agent,
    });

    // add to clients map immediately
    // avoiding races with other clients requesting same id
    clients[id] = client;

    client.once('close', () => {
      logger.info('Client closed: %s', id);
      logger.debug('Removing client: %s due to client close', id);
      this.removeClient(id);
    });

    // try/catch used here to remove client id
    try {
      const info = await agent.listen();
      ++stats.tunnels;
      return {
        id: id,
        port: info.port,
        max_conn_count: maxSockets,
      };
    } catch (err) {
      logger.error('Error creating client: %s', id);
      logger.debug('Removing client: %s due to error', id);
      this.removeClient(id);
      // rethrow error for upstream to handle
      throw err;
    }
  }

  removeClient(id) {
    const client = this.clients[id];
    if (!client) {
      return;
    }
    --this.stats.tunnels;
    delete this.clients[id];
    client.close();
    logger.debug(' -> Client removed: %s', id);
  }

  hasClient(id) {
    return !!this.clients[id];
  }

  getClient(id) {
    return this.clients[id];
  }
}

export default ClientManager;
