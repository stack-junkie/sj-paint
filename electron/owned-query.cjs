const { execFile } = require('node:child_process');

// execFile may report a kill/spawn error before ChildProcess.close. Results
// and resource ownership therefore have distinct completion promises.
function createOwnedQuery(run = execFile) {
  let owner = null;
  function query(command, args, options) {
    if (owner) return owner.result;
    let resolveResult, rejectResult, resolveClose;
    const current = {
      child: null,
      result: new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; }),
      closed: new Promise(resolve => { resolveClose = resolve; }),
    };
    owner = current;
    const release = () => {
      if (owner === current) owner = null;
      resolveClose();
    };
    try {
      current.child = run(command, args, options, (error, stdout) => {
        if (error) rejectResult(error); else resolveResult(stdout);
      });
      current.child.once('close', release);
    } catch (error) {
      // A synchronous launch exception produced no ChildProcess to retain.
      rejectResult(error); release();
    }
    current.rejectResult = rejectResult;
    return current.result;
  }
  return { query, get active() { return owner !== null; }, cancel() {
    const current = owner;
    if (!current) return Promise.resolve();
    // A kill error is a query failure, never proof that the process exited.
    try { current.child?.kill(); } catch (error) { current.rejectResult(error); }
    return current.closed;
  } };
}

module.exports = { createOwnedQuery };
