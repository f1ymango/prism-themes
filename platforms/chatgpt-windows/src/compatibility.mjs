// Only the production build that was inspected and tested is accepted.
export const supportedBuild = Object.freeze({
  packageIdentity: 'OpenAI.Codex',
  version: '26.1103.32239',
  buildFlavor: 'prod',
  archiveHeaderSha256: '8494bdea297b06ca292b71e7cf4b3f395e70a01e0a70fbae2219f620947d8231',
  executableSha256: '5586707af6624c04959ba2c5b4ad6d216a1d8ed17c04937a757495649de44b92',
  archiveSha256: 'fb47d6491dc3006b708cb1e14de479b882bf50f88b7daa81818f154c253266aa',
});

export function assertSupportedBuild(inspection, fingerprint) {
  for (const field of ['packageIdentity', 'version', 'buildFlavor']) {
    if (inspection.metadata[field] !== supportedBuild[field]) throw new Error(`Unsupported app ${field}; inspect and review the new build before running the probe.`);
  }
  for (const field of ['executableSha256', 'archiveSha256']) {
    if (fingerprint[field] !== supportedBuild[field]) throw new Error(`Unsupported app ${field}; installed files differ from the verified baseline.`);
  }
  if (inspection.archiveHeaderSha256 !== supportedBuild.archiveHeaderSha256) throw new Error('Unsupported ASAR header.');
}
