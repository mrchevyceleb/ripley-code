const { classifyCommandVerification } = require('../lib/agenticRunner');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  const mutatingGit = classifyCommandVerification('git fetch origin && git reset --hard origin/main');
  const readonlyGit = classifyCommandVerification('git status --short && git rev-parse HEAD');
  const mutatingFs = classifyCommandVerification('mkdir build-output');

  assert(mutatingGit.requiresVerification === true, 'expected git mutation to require verification');
  assert(mutatingGit.verificationCategory === undefined || mutatingGit.category === 'git_state', 'expected git verification category');
  assert(mutatingGit.verificationHint && mutatingGit.verificationHint.includes('git status'), 'expected git verification hint');

  assert(readonlyGit.requiresVerification === false, 'expected read-only git command to not require verification');
  assert(Array.isArray(readonlyGit.verificationEvidenceFor) && readonlyGit.verificationEvidenceFor.includes('git_state'), 'expected git read-only command to count as verification evidence');

  assert(mutatingFs.requiresVerification === true, 'expected filesystem mutation to require verification');
  assert(mutatingFs.category === 'filesystem_state', 'expected filesystem verification category');

  console.log('command verification regression passed');
  console.log(JSON.stringify({
    mutatingGit,
    readonlyGit,
    mutatingFs
  }, null, 2));
}

run();
