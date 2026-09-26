/**
 * 回环 TCP 代理：对外暴露 CDP 端口，转发到浏览器实际监听的内部端口。
 *
 * 为什么不让浏览器直接对外监听：
 *  1) 本机是 host 网络，任何对外端口都等于把"完全操控浏览器（含读 cookie）"开放给主机上任意进程；
 *     代理只绑 127.0.0.1，且是我们唯一可控的入口（后续可加一次性 token 校验）。
 *  2) 代理知道"当前有没有客户端连着" ⇒ 精确的空闲回收，不需要猜 CDP 活动。
 */
import net from 'node:net';

export function createProxy({ listenPort, targetPort, host = '127.0.0.1', log = () => {}, onConnect = () => {} }) {
  const sockets = new Set();
  let connections = 0;
  let target = targetPort;

  const server = net.createServer((client) => {
    const upstream = net.connect({ host, port: target });
    sockets.add(client);
    sockets.add(upstream);
    connections += 1;
    onConnect();

    const drop = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => {
      sockets.delete(client);
      if (!upstream.destroyed) upstream.end();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!client.destroyed) client.end();
      connections = Math.max(0, connections - 1);
    });

    client.pipe(upstream);
    upstream.pipe(client);
  });

  server.on('error', (err) => log(`proxy error: ${err.message}`));

  return {
    get connections() {
      return connections;
    },
    get targetPort() {
      return target;
    },
    /** 浏览器重启后会换端口，代理必须跟着改指向。 */
    setTarget(port) {
      target = port;
    },
    get listening() {
      return server.listening;
    },
    get port() {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : listenPort;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => {
          server.off('error', reject);
          resolve(this.port);
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
