// Window vetoes happen before will-quit. Once this owner receives will-quit it
// waits for successful cleanup, including a later confirmed resource release.
function createQuitCoordinator({ shutdown, requestQuit, reportFailure, schedule = setImmediate }) {
  let requested = false, ready = false, pending = false, scheduled = false, disposed = false, releaseRevision = 0;
  function enqueue() {
    if (disposed || scheduled || !requested) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (disposed || !requested) return;
      if (ready) { requested = false; requestQuit(); }
      else attempt();
    });
  }
  function attempt() {
    if (disposed || ready || pending || !requested) return;
    pending = true;
    const revision = releaseRevision;
    Promise.resolve().then(shutdown).then(result => {
      if (disposed) return;
      pending = false;
      if (result?.ok) { ready = true; enqueue(); }
      else {
        reportFailure?.(result);
        // A close can arrive while shutdown's original failure is settling.
        // Preserve that failure and consume the new ownership fact exactly once.
        if (releaseRevision !== revision) enqueue();
      }
    }, error => {
      if (disposed) return;
      pending = false;
      reportFailure?.({ ok: false, error: { code: 'CLEANUP', message: error?.message || 'Shutdown failed.' } });
      if (releaseRevision !== revision) enqueue();
    });
  }
  return {
    willQuit(event) {
      if (disposed || ready) return;
      event.preventDefault(); requested = true; attempt();
    },
    ownershipReleased() {
      if (disposed || ready) return;
      releaseRevision++;
      if (requested && !pending) enqueue();
    },
    dispose() { disposed = true; requested = false; },
  };
}
module.exports = { createQuitCoordinator };
