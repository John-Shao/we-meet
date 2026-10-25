// Release admission check for R0a images. Evidence is the parsed output of
// cosign verify / provenance / SBOM / scanner; this module only decides.

const PLACEHOLDER = /^sha256:(.)\1{63}$/;

function fail(errors, code, detail) {
  errors.push({ code, detail });
}

export function evaluateRelease(policy, evidence, { now = new Date() } = {}) {
  const errors = [];
  const image = evidence?.image ?? {};

  if (!new RegExp(policy.image.digest_pattern).test(image.digest ?? '')) {
    fail(errors, 'image_digest_invalid', image.digest ?? null);
  } else if (policy.image.forbid_placeholder_digest && PLACEHOLDER.test(image.digest)) {
    fail(errors, 'image_digest_placeholder', image.digest);
  }
  if (policy.image.tag_only_reference === 'deny' && image.reference && !image.reference.includes('@sha256:')) {
    fail(errors, 'image_reference_not_pinned', image.reference);
  }
  if (!policy.image.base_images_allowlist.includes(image.base)) {
    fail(errors, 'base_image_not_allowed', image.base ?? null);
  }

  const sig = evidence?.signature;
  if (!sig?.verified) {
    fail(errors, 'signature_unverified', null);
  } else {
    if (!policy.signature.allowed_issuers.includes(sig.issuer)) fail(errors, 'signature_issuer', sig.issuer);
    if (!policy.signature.allowed_subject_prefixes.some((prefix) => sig.subject?.startsWith(prefix))) {
      fail(errors, 'signature_subject', sig.subject ?? null);
    }
    if (policy.signature.require_rekor_entry && !sig.rekor_log_index) fail(errors, 'signature_no_rekor', null);
    if (sig.digest !== image.digest) fail(errors, 'signature_digest_mismatch', sig.digest ?? null);
  }

  const prov = evidence?.provenance;
  if (!prov || prov.format !== policy.provenance.format) {
    fail(errors, 'provenance_missing', prov?.format ?? null);
  } else {
    if ((prov.slsa_build_level ?? 0) < policy.provenance.min_slsa_build_level) {
      fail(errors, 'provenance_level', prov.slsa_build_level ?? null);
    }
    if (!policy.provenance.allowed_builders.includes(prov.builder_id)) fail(errors, 'provenance_builder', prov.builder_id);
    if (prov.subject_digest !== image.digest) fail(errors, 'provenance_digest_mismatch', prov.subject_digest ?? null);
  }

  const sbom = evidence?.sbom;
  if (!sbom || !policy.sbom.formats.includes(sbom.format)) {
    fail(errors, 'sbom_missing', sbom?.format ?? null);
  } else {
    const components = sbom.components ?? [];
    const incomplete = components.filter((c) => policy.sbom.required_fields.some((field) => !c[field]));
    if (incomplete.length) fail(errors, 'sbom_component_incomplete', incomplete.length);
    for (const [purlBase, version] of Object.entries(policy.sbom.pinned_components)) {
      const hits = components.filter((c) => c.purl?.split('@')[0] === purlBase);
      if (hits.length !== 1 || hits[0].version !== version) {
        fail(errors, 'sbom_pin_mismatch', `${purlBase}@${hits.map((h) => h.version).join(',') || 'absent'}`);
      }
    }
    const forbidden = components.filter((c) =>
      policy.sbom.forbidden_components.includes(c.purl?.split('@')[0]),
    );
    if (forbidden.length) fail(errors, 'sbom_forbidden_component', forbidden.map((c) => c.purl).join(','));
    if (policy.sbom.lockfile_required && !sbom.lockfile_sha256) fail(errors, 'lockfile_missing', null);
  }

  const vulns = evidence?.vulnerabilities ?? null;
  if (!vulns) {
    fail(errors, 'scan_missing', null);
  } else {
    const waivers = new Map((vulns.waivers ?? []).map((w) => [w.id, w]));
    const maxMs = policy.vulnerabilities.waiver.max_days * 86_400_000;
    const unwaived = { critical: 0, high: 0 };
    for (const finding of vulns.findings ?? []) {
      if (!['critical', 'high'].includes(finding.severity)) continue;
      const waiver = waivers.get(finding.id);
      const valid =
        waiver &&
        policy.vulnerabilities.waiver.allowed_severities.includes(finding.severity) &&
        policy.vulnerabilities.waiver.requires.every((field) => waiver[field]) &&
        new Date(waiver.expires_at) > now &&
        new Date(waiver.expires_at) - now <= maxMs;
      if (!valid) unwaived[finding.severity] += 1;
    }
    if (unwaived.critical > policy.vulnerabilities.max_critical) fail(errors, 'vuln_critical', unwaived.critical);
    if (unwaived.high > policy.vulnerabilities.max_high) fail(errors, 'vuln_high', unwaived.high);
  }

  return { admitted: errors.length === 0, errors };
}
