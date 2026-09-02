/** Deterministic, script-free report renderers over one canonical content projection. */

import { Buffer } from 'node:buffer';

import { canonicalJson, compareCodeUnits, sha256 } from './domain/canonical.js';
import type { CoverageRatio } from './domain/coverage.js';
import type { TimeRange } from './domain/model.js';
import type { CoverageReadinessReport } from './domain/readiness.js';
import type { ReportTimeBasis } from './domain/time.js';
import { requireStrictArray, requireStrictRecord } from './domain/validation.js';
import { normalizeReportContentProjection } from './report-schema.js';

export const RECEIPT_CLAIM = 'evidence assembled' as const;
export const ARTIFACT_STATUS = 'Draft—not submitted; human review required' as const;
export const NON_DETERMINATION_LIMITATION =
  'not a compliance, safety, water-quality, engineering, laboratory-quality, legal-sufficiency, regulatory-filing, or approval determination' as const;

export interface ReportContentProjection {
  readonly schemaVersion: 'report-content-projection/v3';
  readonly claim: typeof RECEIPT_CLAIM;
  readonly artifactStatus: typeof ARTIFACT_STATUS;
  readonly unsigned: true;
  readonly submittable: false;
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportPeriod: TimeRange;
  readonly seriesMetadata: readonly ReportSeriesMetadata[];
  readonly requiredSeries: readonly ReportRequiredSeries[];
  readonly coverageReadiness: CoverageReadinessReport;
  readonly limitations: readonly [typeof NON_DETERMINATION_LIMITATION];
}

/** Report-safe coverage aggregate; detailed evidence routing remains receipt-internal. */
export interface ReportRequiredSeries {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly governingContractHash: string;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly expectedCount: number;
  readonly acceptedCount: number;
  readonly gapCount: number;
  readonly duplicateCount: number;
  readonly quarantineCount: number;
  readonly coverage: CoverageRatio;
}

/** Immutable, report-safe descriptors copied from each governing required-series contract. */
export interface ReportSeriesMetadata {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly governingContractHash: string;
  readonly processCode: string;
  readonly parameterCode: string;
  readonly statistic: string;
  readonly canonicalUnit: string;
  readonly sourceTimeZone: string;
  readonly criticality: 'required' | 'report_critical';
  readonly aggregateMembership: readonly string[];
}

export type ReportMediaType = 'application/json' | 'text/csv' | 'text/html';

export type ReportArtifactFilename =
  'coverage-report.csv' | 'coverage-report.html' | 'coverage-report.json';

export interface RenderArtifact {
  readonly mediaType: ReportMediaType;
  readonly logicalFilename: ReportArtifactFilename;
  readonly utf8Text: string;
}

export interface RenderManifestItem {
  readonly mediaType: ReportMediaType;
  readonly logicalFilename: ReportArtifactFilename;
  readonly byteLength: number;
  readonly sha256: string;
}

const safeArtifactFilenames: ReadonlySet<string> = new Set([
  'coverage-report.csv',
  'coverage-report.html',
  'coverage-report.json',
]);

const mediaTypeByFilename: Readonly<Record<ReportArtifactFilename, ReportMediaType>> = {
  'coverage-report.csv': 'text/csv',
  'coverage-report.html': 'text/html',
  'coverage-report.json': 'application/json',
};

/** Reject dynamic/path-shaped output names even if a caller bypasses TypeScript. */
export function requireSafeArtifactFilename(value: string): ReportArtifactFilename {
  if (!safeArtifactFilenames.has(value) || value.includes('/') || value.includes('\\')) {
    throw new TypeError('report artifact filename is not allowlisted');
  }
  return value as ReportArtifactFilename;
}

/** Resolve the one media type allowlisted for a report artifact filename. */
export function artifactMediaType(value: string): ReportMediaType {
  return mediaTypeByFilename[requireSafeArtifactFilename(value)];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function coverageLabel(summary: ReportRequiredSeries): string {
  return summary.coverage.state === 'not_applicable'
    ? 'Not applicable (zero expected intervals)'
    : `${summary.coverage.numerator.toString()} of ${summary.coverage.denominator.toString()} expected intervals`;
}

function metadataForSummary(
  projection: ReportContentProjection,
  summary: ReportRequiredSeries,
): ReportSeriesMetadata {
  const metadata = projection.seriesMetadata.find(
    (candidate) =>
      candidate.contractId === summary.contractId &&
      candidate.contractVersion === summary.contractVersion,
  );
  if (metadata === undefined) {
    throw new RangeError('required series has no immutable metadata');
  }
  return metadata;
}

function reportTimeZone(summary: ReportRequiredSeries): string {
  return summary.reportTimeBasis.kind === 'utc' ? 'UTC' : summary.reportTimeBasis.timeZone;
}

function renderHtml(projection: ReportContentProjection, reportContentHash: string): string {
  const rows = projection.requiredSeries
    .map((summary) => {
      const metadata = metadataForSummary(projection, summary);
      return `        <tr>
          <th scope="row">${escapeHtml(summary.contractId)}</th>
          <td>${escapeHtml(summary.contractVersion)}</td>
          <td>${escapeHtml(metadata.parameterCode)}</td>
          <td>${escapeHtml(metadata.statistic)}</td>
          <td>${escapeHtml(metadata.canonicalUnit)}</td>
          <td>${escapeHtml(metadata.sourceTimeZone)}</td>
          <td>${escapeHtml(reportTimeZone(summary))}</td>
          <td>${escapeHtml(coverageLabel(summary))}</td>
          <td>${summary.acceptedCount.toString()}</td>
          <td>${summary.expectedCount.toString()}</td>
          <td>${summary.gapCount.toString()}</td>
          <td>${summary.duplicateCount.toString()}</td>
          <td>${summary.quarantineCount.toString()}</td>
        </tr>`;
    })
    .join('\n');
  const readiness = projection.coverageReadiness.state.replaceAll('_', ' ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ReuseProof CA evidence coverage draft</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
    body { margin: 0 auto; max-width: 80rem; padding: 1rem; }
    .skip-link { left: -10000px; position: absolute; }
    .skip-link:focus { left: 1rem; top: 1rem; }
    .status, .limitation { border: 0.2rem solid currentColor; padding: 0.75rem; }
    .table-region { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    caption { font-weight: 700; text-align: left; }
    th, td { border: 0.1rem solid currentColor; padding: 0.5rem; text-align: left; vertical-align: top; }
    code { overflow-wrap: anywhere; }
    @media (max-width: 40rem) { body { padding: 0.5rem; } th, td { padding: 0.3rem; } }
    @media print { .skip-link { display: none; } body { max-width: none; } }
    @media (forced-colors: active) { .status, .limitation, th, td { border-color: CanvasText; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#report-content">Skip to report content</a>
  <header>
    <h1>Evidence coverage draft</h1>
    <p class="status"><strong>${escapeHtml(ARTIFACT_STATUS)}</strong></p>
  </header>
  <main id="report-content">
    <section aria-labelledby="report-scope-heading">
      <h2 id="report-scope-heading">Report scope</h2>
      <dl>
        <dt>Tenant</dt><dd>${escapeHtml(projection.tenantId)}</dd>
        <dt>System</dt><dd>${escapeHtml(projection.systemId)}</dd>
        <dt>Period start (UTC)</dt><dd><time datetime="${escapeHtml(projection.reportPeriod.start)}">${escapeHtml(projection.reportPeriod.start)}</time></dd>
        <dt>Period end (UTC, exclusive)</dt><dd><time datetime="${escapeHtml(projection.reportPeriod.end)}">${escapeHtml(projection.reportPeriod.end)}</time></dd>
        <dt>Data-coverage preflight</dt><dd>${escapeHtml(readiness)}</dd>
        <dt>Report content SHA-256</dt><dd><code>${reportContentHash}</code></dd>
      </dl>
    </section>
    <section aria-labelledby="coverage-heading">
      <h2 id="coverage-heading">Required-series coverage</h2>
      <p>Gaps are explicit. Duplicate and quarantined observations do not increase accepted coverage.</p>
      <div class="table-region" role="region" aria-label="Required-series coverage table" tabindex="0">
        <table>
          <caption>Coverage by immutable required-series contract</caption>
          <thead>
            <tr>
              <th scope="col">Contract</th>
              <th scope="col">Version</th>
              <th scope="col">Parameter</th>
              <th scope="col">Statistic</th>
              <th scope="col">Canonical unit</th>
              <th scope="col">Source time zone</th>
              <th scope="col">Report time zone</th>
              <th scope="col">Coverage</th>
              <th scope="col">Accepted</th>
              <th scope="col">Expected</th>
              <th scope="col">Gaps</th>
              <th scope="col">Duplicates</th>
              <th scope="col">Quarantined</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
    </section>
    <section aria-labelledby="meaning-heading">
      <h2 id="meaning-heading">What this artifact means</h2>
      <p><strong>Claim:</strong> ${escapeHtml(RECEIPT_CLAIM)}.</p>
      <p class="limitation"><strong>Limitation:</strong> ${escapeHtml(NON_DETERMINATION_LIMITATION)}.</p>
      <p>This unsigned artifact cannot be submitted by ReuseProof CA and is not a certificate or signature.</p>
    </section>
  </main>
  <footer>
    <p>Generated deterministically from the canonical report-content projection.</p>
  </footer>
</body>
</html>
`;
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^(?:[\t\r\n]|\s*[=+@-])/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number): string {
  const text = neutralizeSpreadsheetFormula(String(value)).replaceAll('"', '""');
  return `"${text}"`;
}

function renderCsv(projection: ReportContentProjection, reportContentHash: string): string {
  const headers = [
    'schema_version',
    'report_content_sha256',
    'artifact_status',
    'claim',
    'limitation',
    'tenant_id',
    'system_id',
    'report_period_start_utc',
    'report_period_end_exclusive_utc',
    'coverage_preflight_state',
    'contract_id',
    'contract_version',
    'process_code',
    'parameter_code',
    'statistic',
    'canonical_unit',
    'source_time_zone',
    'report_time_basis_kind',
    'report_time_zone',
    'coverage_state',
    'coverage_numerator',
    'coverage_denominator',
    'accepted_count',
    'expected_count',
    'gap_count',
    'duplicate_count',
    'quarantine_count',
  ];
  const rows = projection.requiredSeries.map((summary) => {
    const metadata = metadataForSummary(projection, summary);
    const measured = summary.coverage.state === 'measured';
    return [
      projection.schemaVersion,
      reportContentHash,
      ARTIFACT_STATUS,
      RECEIPT_CLAIM,
      NON_DETERMINATION_LIMITATION,
      projection.tenantId,
      projection.systemId,
      projection.reportPeriod.start,
      projection.reportPeriod.end,
      projection.coverageReadiness.state,
      summary.contractId,
      summary.contractVersion,
      metadata.processCode,
      metadata.parameterCode,
      metadata.statistic,
      metadata.canonicalUnit,
      metadata.sourceTimeZone,
      summary.reportTimeBasis.kind,
      reportTimeZone(summary),
      summary.coverage.state,
      measured ? summary.coverage.numerator : '',
      measured ? summary.coverage.denominator : '',
      summary.acceptedCount,
      summary.expectedCount,
      summary.gapCount,
      summary.duplicateCount,
      summary.quarantineCount,
    ]
      .map(csvCell)
      .join(',');
  });
  return `${[headers.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}

function renderJson(projection: ReportContentProjection, reportContentHash: string): string {
  return canonicalJson({
    schemaVersion: 'accessible-report-json/v1',
    reportContentHash,
    artifactStatus: ARTIFACT_STATUS,
    claim: RECEIPT_CLAIM,
    limitations: [NON_DETERMINATION_LIMITATION],
    reportContent: projection,
  });
}

/** Render stable UTF-8 bytes only after the caller has hashed canonical report content. */
export function renderReportArtifacts(
  projection: ReportContentProjection,
  reportContentHash: string,
): readonly RenderArtifact[] {
  if (!/^[0-9a-f]{64}$/.test(reportContentHash)) {
    throw new TypeError('report content hash must be lowercase SHA-256 hex');
  }
  const normalizedProjection = normalizeReportContentProjection(projection);
  const expectedContentHash = sha256(canonicalJson(normalizedProjection));
  if (reportContentHash !== expectedContentHash) {
    throw new RangeError('report content hash does not match the canonical report projection');
  }
  const artifacts: readonly RenderArtifact[] = [
    {
      mediaType: 'application/json',
      logicalFilename: 'coverage-report.json',
      utf8Text: renderJson(normalizedProjection, reportContentHash),
    },
    {
      mediaType: 'text/csv',
      logicalFilename: 'coverage-report.csv',
      utf8Text: renderCsv(normalizedProjection, reportContentHash),
    },
    {
      mediaType: 'text/html',
      logicalFilename: 'coverage-report.html',
      utf8Text: renderHtml(normalizedProjection, reportContentHash),
    },
  ];
  return artifacts.map((artifact) => Object.freeze({ ...artifact }));
}

/** Hash exact render bytes and sort the manifest by media type then logical filename. */
export function createRenderManifest(
  artifacts: readonly RenderArtifact[],
): readonly RenderManifestItem[] {
  const names = new Set<string>();
  const manifest = requireStrictArray(artifacts, 'render artifacts').map((artifact, index) => {
    const label = `render artifacts[${index.toString()}]`;
    const record = requireStrictRecord(
      artifact,
      ['mediaType', 'logicalFilename', 'utf8Text'],
      [],
      label,
    );
    if (typeof record.logicalFilename !== 'string') {
      throw new TypeError(`${label}.logicalFilename must be text`);
    }
    const logicalFilename = requireSafeArtifactFilename(record.logicalFilename);
    const mediaType = artifactMediaType(logicalFilename);
    if (record.mediaType !== mediaType) {
      throw new TypeError('render artifact media type does not match its allowlisted filename');
    }
    if (typeof record.utf8Text !== 'string') {
      throw new TypeError('render artifact bytes must be represented as UTF-8 text');
    }
    if (names.has(logicalFilename)) {
      throw new TypeError('render artifact filenames must be unique');
    }
    names.add(logicalFilename);
    return {
      mediaType,
      logicalFilename,
      byteLength: Buffer.byteLength(record.utf8Text, 'utf8'),
      sha256: sha256(record.utf8Text),
    };
  });
  return manifest
    .sort((left, right) => compareCodeUnits(left.mediaType, right.mediaType))
    .map((item) => Object.freeze(item));
}
