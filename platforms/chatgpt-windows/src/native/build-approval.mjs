export const BUILD_CONTRACT = 1;
const fields = ['package', 'image', 'executableSha256', 'archiveSha256'];

export function validateBuild(build) {
  if (!build || !/^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$/.test(build.package) || typeof build.image !== 'string' || !/[\\/]app[\\/]ChatGPT\.exe$/i.test(build.image)) throw new Error('Unsupported registered app identity or layout');
  for (const key of ['executableSha256', 'archiveSha256']) if (!/^[0-9a-f]{64}$/i.test(build[key])) throw new Error('Invalid app fingerprint');
  return build;
}

export function approvedBuild(cache, candidate) {
  validateBuild(candidate);
  return cache?.schema === 1 ? cache.builds?.find(build => build.contract === BUILD_CONTRACT && fields.every(key => build[key]?.toLowerCase() === candidate[key]?.toLowerCase())) ?? null : null;
}

export function addApproval(cache, approval) {
  validateBuild(approval);
  if (approval.contract !== BUILD_CONTRACT || !approval.passed || !['imageVisible','settingsChanged','restored','installedFilesUnchanged','listenerClosed'].every(key => approval.checks?.[key] === true)) throw new Error('A passing renderer contract is required');
  return { schema: 1, builds: [...(cache?.builds ?? []).filter(build => !fields.every(key => build[key] === approval[key])), approval].slice(-16) };
}
