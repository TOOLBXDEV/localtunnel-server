import { randomBytes } from 'crypto';
import Debug from 'debug';
import http, { IncomingMessage, ServerResponse } from 'http';
import Koa from 'koa';
import Router from 'koa-router';
import type { Socket } from 'net';
import tldjs from 'tldjs';
import ClientManager from './lib/ClientManager';
import { endOrDestroy } from './lib/utils';

const logger = {
  debug: Debug('localtunnel:server:debug'),
  error: Debug('localtunnel:server:error'),
};

interface ServerOptions {
  domain?: string;
  landing?: string;
  secure?: boolean;
  max_tcp_sockets?: number;
}

function generateRandomHexString(length: number = 10): string {
  // We need enough bytes so that when converted to hex (2 characters per byte)
  // we have at least the requested length. Math.ceil(length/2) calculates that.
  const bytes = randomBytes(Math.ceil(length / 2));
  const hex = bytes.toString('hex');
  return hex.slice(0, length);
}

export default function (opt: ServerOptions = {}) {
  const validHosts = opt.domain ? [opt.domain] : undefined;
  const myTldjs = tldjs.fromUserSettings({ validHosts });
  const landingPage = opt.landing || 'https://localtunnel.github.io/www/';

  function GetClientIdFromHostname(hostname: string): string | null {
    // The myTldjs.getSubdomain() function will return null for localhost
    if (hostname.match(/\.localhost(:\d+)?$/g)) {
      return hostname.split('.')[0];
    }
    return myTldjs.getSubdomain(hostname);
  }

  const manager = new ClientManager(opt);

  const schema = opt.secure ? 'https' : 'http';

  const app = new Koa();
  const router = new Router();

  router.get('/api/status', async (ctx, next) => {
    const stats = manager.stats;
    ctx.body = {
      tunnels: stats.tunnels,
      mem: process.memoryUsage(),
    };
  });

  router.get('/api/tunnels/:id/status', async (ctx, next) => {
    const clientId = ctx.params.id;
    const client = manager.getClient(clientId);
    if (!client) {
      ctx.throw(405);
      return;
    }

    const stats = client.stats();
    ctx.body = {
      connected_sockets: stats.connectedSockets,
    };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  router.del('/api/tunnels/:id', async (ctx, next) => {
    const clientId = ctx.params.id;
    const client = manager.getClient(clientId);
    if (!client) {
      ctx.throw(405);
      return;
    }

    try {
      logger.debug(`Removing client with id ${clientId} due to API request`);
      manager.removeClient(clientId);
    } catch (e) {
      logger.error(e);
      ctx.throw(405);
      return;
    }

    ctx.body = {
      deletedClientId: clientId,
    };
  });

  app.use(async (ctx, next) => {
    const method = ctx.request.method;
    const path = ctx.request.path;
    const query = ctx.request.query;
    logger.debug('Incoming request', method, path, JSON.stringify(query));
    await next();
  });

  // root endpoint
  app.use(async (ctx, next) => {
    const path = ctx.request.path;

    // skip anything not on the root path
    if (path !== '/') {
      await next();
      return;
    }

    const isNewClientRequest = ctx.query['new'] !== undefined;
    if (isNewClientRequest) {
      const reqId = generateRandomHexString(10);
      logger.debug('Making new client with id %s', reqId);
      const info = await manager.newClient(reqId);

      const url = schema + '://' + info.id + '.' + ctx.request.host;
      info.url = url;
      ctx.body = info;
      return;
    }

    // no new client request, send to landing page
    ctx.redirect(landingPage);
  });

  // anything after the / path is a request for a specific client name
  // This is a backwards compat feature
  app.use(async (ctx, next) => {
    const parts = ctx.request.path.split('/');

    // any request with several layers of paths is not allowed
    // rejects /foo/bar
    // allow /foo
    if (parts.length !== 2) {
      await next();
      return;
    }

    const reqId = parts[1];
    logger.debug('reqId:', reqId);

    // limit requested hostnames to 63 characters
    if (!/^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)) {
      const msg =
        'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
      ctx.status = 403;
      ctx.body = {
        message: msg,
      };
      return;
    }

    logger.debug('Making new client with id %s', reqId);
    const info = await manager.newClient(reqId);

    const url = schema + '://' + info.id + '.' + ctx.request.host;
    info.url = url;
    ctx.body = info;
    return;
  });

  const server = http.createServer();

  const appCallback = app.callback();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const hostname = req.headers.host;
    if (!hostname) {
      res.statusCode = 400;
      res.end('Host header is required');
      return;
    }

    const clientId = GetClientIdFromHostname(hostname);
    if (!clientId) {
      appCallback(req, res);
      return;
    }

    const client = manager.getClient(clientId);
    if (!client) {
      console.log('Client not found for id', clientId);
      res.statusCode = 405;
      res.end('405');
      return;
    }

    client.handleRequest(req, res);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const hostname = req.headers.host;
    if (!hostname) {
      endOrDestroy(socket);
      return;
    }

    const clientId = GetClientIdFromHostname(hostname);
    if (!clientId) {
      endOrDestroy(socket);
      return;
    }

    const client = manager.getClient(clientId);
    if (!client) {
      endOrDestroy(socket);
      return;
    }

    client.handleUpgrade(req, socket);
  });

  return server;
}
