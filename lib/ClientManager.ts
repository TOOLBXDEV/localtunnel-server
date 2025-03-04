import Debug from 'debug';
import Client from './Client';
import TunnelAgent from './TunnelAgent';

const logger = {
  debug: Debug('lt:ClientManager:debug'),
  info: Debug('lt:ClientManager:info'),
  error: Debug('lt:ClientManager:error'),
};

interface ClientManagerOptions {
  max_tcp_sockets?: number;
}

interface ClientInfo {
  id: string;
  port: number;
  max_conn_count: number;
  url?: string;
}

interface Stats {
  tunnels: number;
}

// Manage sets of clients
//
// A client is a "user session" established to service a remote localtunnel client
class ClientManager {
  stats: Stats;

  private opt: ClientManagerOptions;
  private clients: Map<string, Client>;
  private graceTimeout: NodeJS.Timeout | null;

  constructor(opt: ClientManagerOptions = {}) {
    this.opt = opt;

    // id -> client instance
    this.clients = new Map();
    this.stats = {
      tunnels: 0,
    };
    this.graceTimeout = null;
  }

  // create a new tunnel with `id`
  // if the id is already used, a random id is assigned
  // if the tunnel could not be created, throws an error
  async newClient(id: string): Promise<ClientInfo> {
    const clients = this.clients;
    const stats = this.stats;

    // can't ask for id already is use
    if (clients.has(id)) {
      logger.info(
        `Client with id "${id}" already exists. Removing old client and creating new one.`
      );
      this.removeClient(id);
    }

    // This is how many sockets the client will try to keep up
    const maxSockets = this.opt.max_tcp_sockets ?? 10;
    const agent = new TunnelAgent({
      clientId: id,
      maxClientSockets: maxSockets,
      // This is how many sockets the server can accept before throwing an
      // error. Set it to 2x in case the client is slow to close sockets.
      maxTcpSockets: maxSockets * 2,
    });

    const client = new Client({
      id,
      agent,
    });

    // add to clients map immediately
    // avoiding races with other clients requesting same id
    clients.set(id, client);

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

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) {
      return;
    }
    --this.stats.tunnels;
    this.clients.delete(id);
    client.close();
    logger.debug(' -> Client removed: %s', id);
  }

  hasClient(id: string): boolean {
    return this.clients.has(id);
  }

  getClient(id: string): Client | undefined {
    return this.clients.get(id);
  }
}

export default ClientManager;
