/**
 * First tries to end the socket with a FIN, so that the client can exit itself.
 * If it doesn't work then destroys it.
 * @param {net.Socket} socket
 */
export function endOrDestroy(socket) {
  const timeout = setTimeout(() => socket.destroy(), 1000);
  socket.end(() => {
    clearTimeout(timeout);
  });
}
