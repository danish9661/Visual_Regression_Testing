import fs from 'node:fs';
import path from 'node:path';

/**
 * Human-readable report for `visual-ci compare-branches`: a PR/MR comment body,
 * a CI step summary and a downloadable Markdown file.
 */

export const BRANCH_MARKER = '<!-- visual-branch-compare -->';

const escapeCell = (value) => String(value ?? '')
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, '<br>')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const escapeXml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');
const short = (sha) => (sha || '').substring(0, 10);
const link = (label, file) => (file ? `[${label}](<${escapeCell(file)}>)` : '_n/a_');

function suspectCell(snapshot) {
  const top = snapshot.suspects?.[0];
  if (!top) return '_no likely source found_';
  const where = top.line ? `${escapeCell(top.path)}:${top.line}` : escapeCell(top.path);
  return `\`${where}\` (${top.confidence}) — ${escapeCell(top.reason)}`;
}

/**
 * @param {object} options
 * @param {object} options.result - `visual-branch-compare` result
 * @param {number} [options.maxRows=25]
 * @param {object[]} [options.fileImpacts=[]]
 * @param {string} [options.diffText='']
 * @returns {string} GitHub/GitLab flavoured Markdown
 */
export function generateBranchReportMarkdown({ result, maxRows = 25, fileImpacts = [], diffText = '' }) {
  const changed = result.snapshots.filter((s) => s.status === 'DIFF' || s.status === 'MISSING_BASE');
  const ordered = [...changed, ...result.snapshots.filter((s) => !changed.includes(s))];
  const shown = ordered.slice(0, maxRows);
  const verdict = result.skipped
    ? '⏭️ **Skipped** — no rendering-relevant files changed in this PR.'
    : changed.length === 0
      ? '✅ **No visual differences** between the two branches.'
      : `❌ **${changed.length} visual change${changed.length === 1 ? '' : 's'}** above the threshold.`;

  const lines = [
    BRANCH_MARKER,
    '# 📸 Visual branch comparison',
    '',
    verdict,
    '',
    `| | |`,
    `| :--- | :--- |`,
    `| Base | \`${escapeCell(result.base?.ref || '')}\` @ \`${short(result.base?.sha)}\` (${escapeCell(result.base?.strategy || '')}) |`,
    `| Head | \`${escapeCell(result.head?.ref || '')}\` @ \`${short(result.head?.sha)}\` |`,
    `| Threshold | ${result.threshold_percentage}% mismatch |`,
    `| Snapshots | ${result.counts.total} · ${result.counts.changed} changed |`,
    `| Policy | \`${escapeCell(result.on_regression)}\` |`,
    '',
    '| Route | Viewport | Change | Likely code change | Images |',
    '| :--- | :--- | ---: | :--- | :--- |'
  ];

  for (const snapshot of shown) {
    const status = snapshot.status === 'MATCH' ? '—' : snapshot.status === 'MISSING_BASE' ? 'new' : `${snapshot.mismatch_percentage}%`;
    const noise = snapshot.noise_filtered ? ' ⚠️ unstable, filtered' : '';
    lines.push(
      `| \`${escapeCell(snapshot.route)}\` | \`${escapeCell(snapshot.viewport)}\` | ${status}${noise} | ` +
      `${suspectCell(snapshot)} | ${link('before', snapshot.base)} · ${link('after', snapshot.head)} · ${link('diff', snapshot.diff)} |`
    );
  }
  if (ordered.length > shown.length) lines.push('', `_Showing ${shown.length} of ${ordered.length} snapshots; full data is in the artifact._`);

  if (fileImpacts.length) {
    lines.push('', '### Changed files that may explain a visual change', '');
    for (const file of fileImpacts.slice(0, 20)) {
      const list = file.snapshots.slice(0, 5).map((s) => `\`${escapeCell(s)}\``).join(', ');
      lines.push(`- \`${escapeCell(file.path)}\` — ${file.snapshots.length} snapshot(s): ${list}`);
    }
  }

  if (diffText) {
    lines.push('', '<details><summary>Full git diff (first 5000 characters)</summary>', '', '```diff',
      diffText.slice(0, 5000), '```', '', '</details>');
  }

  lines.push(
    '',
    '> ℹ️ Likely code changes are **heuristic matches** (changed selectors, route/source mappings, path names), not proof of cause. Check the diff images before approving.',
    ''
  );
  return lines.join('\n');
}

/** Minimal JUnit XML so CI UIs can show one test case per snapshot. */
export function generateJUnit({ result }) {
  const cases = result.snapshots.map((snapshot) => {
    const failed = snapshot.status !== 'MATCH';
    const body = failed
      ? `    <failure message="${escapeXml(`${snapshot.route} @ ${snapshot.viewport}: ${snapshot.status} (${snapshot.mismatch_percentage}%)`)}" type="visual-change"/>`
      : '';
    return `  <testcase classname="visual-branch-compare" name="${escapeXml(`${snapshot.route} @ ${snapshot.viewport}`)}">${body ? `\n${body}\n  ` : ''}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="visual-branch-compare" tests="${result.counts.total}" failures="${result.counts.changed}" errors="0" time="0">`,
    ...cases,
    '</testsuite>',
    ''
  ].join('\n');
}

/**
 * Writes the Markdown file and appends to GITHUB_STEP_SUMMARY when present.
 * @returns {{ reportPath: string|null, stepSummaryWritten: boolean }}
 */
export function writeBranchReport(markdown, { outputDir, fileName = 'report.md', stepSummary = true } = {}) {
  let reportPath = null;
  let stepSummaryWritten = false;
  if (outputDir) {
    reportPath = path.join(outputDir, fileName);
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, markdown, 'utf8');
    } catch {
      reportPath = null;
    }
  }
  const stepFile = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary && stepFile) {
    try {
      fs.appendFileSync(stepFile, `\n${markdown}\n`, 'utf8');
      stepSummaryWritten = true;
    } catch { /* not fatal */ }
  }
  return { reportPath, stepSummaryWritten };
}
