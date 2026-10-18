// One result representation for browser, desktop and focused verification.
export function createVerificationResults({ onResult } = {}) {
  const checks = [];
  const record = result => { checks.push(result); onResult?.(result); };
  const check = (name, ok, detail = null) => {
    if (typeof ok !== 'boolean') throw new TypeError(`Verification must return a boolean: ${name}`);
    record({ name, ok, detail });
    if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  };
  check.skip = (name, reason) => record({ name, skipped: true, reason });
  return { checks, check, summary: () => summarizeVerification(checks) };
}

export function summarizeVerification(checks) {
  return {
    passed: checks.filter(result => result.ok === true && result.skipped !== true).length,
    skipped: checks.filter(result => result.skipped === true),
    failed: checks.filter(result => result.ok === false),
  };
}
