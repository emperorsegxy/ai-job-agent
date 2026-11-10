import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CandidateProfile } from '../src/config/firebase';
import { applyProfileUpdate, type ProfileStore } from '../src/modules/cv-parser/profile-update';
import { JobspyRunner, buildJobspyArgs } from '../src/modules/harvester/jobspy-runner';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubScript = path.join(repoRoot, 'tests/fixtures/echo_argv.py');
const wrapperScript = path.join(repoRoot, 'jobspy_wrapper.py');

const SENTINELS = [
  '/tmp/pwned-rg002',
  '/tmp/pwned-rg002-dollar',
  '/tmp/pwned-rg002-bt',
  '/tmp/pwned-rg002-nl',
  '/tmp/pwned-rg002-loc',
];

const QUOTE_BREAK = '"; touch /tmp/pwned-rg002; "';
const DOLLAR = '$(touch /tmp/pwned-rg002-dollar)';
const BACKTICK = '`touch /tmp/pwned-rg002-bt`';
const NEWLINE_ROLE = 'line1\ntouch /tmp/pwned-rg002-nl';
const NEWLINE_LOCATION = 'Berlin\ntouch /tmp/pwned-rg002-loc';

function clearSentinels() {
  for (const file of SENTINELS) {
    fs.rmSync(file, { force: true });
  }
}

function assertSentinelsAbsent() {
  const present = SENTINELS.filter((file) => fs.existsSync(file));
  assert.deepEqual(present, [], `sentinel files were created: ${present.join(', ')}`);
}

function validProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    name: 'Makinde Akinola',
    email: 'makinde@example.com',
    phone: '+234 800 000 0000',
    location: 'Lagos, Nigeria',
    professionalSummary: 'Engineer who ships product.',
    targetRoles: ['Senior Full-Stack Engineer'],
    potentiallyQualifiedRoles: ['Backend Engineer'],
    targetLocations: ['Remote Worldwide', 'Europe (UK, Germany, Netherlands, Ireland)'],
    coreSkills: ['Full-Stack Development'],
    toolsAndPlatforms: ['TypeScript', 'Node.js'],
    skills: { core: ['Full-Stack Development'], tools: ['TypeScript'] },
    customCategories: [],
    experienceYears: 6,
    salaryExpectationEUR: { min: 65000, target: 80000, currency: 'EUR' },
    workAuthorization: 'Relocation Ready / Remote Worldwide',
    cvStoragePath: '',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function memoryStore(initial: CandidateProfile | null): ProfileStore & { snapshot: () => CandidateProfile | null } {
  let current = initial ? structuredClone(initial) : null;
  return {
    async getProfile() {
      return current ? structuredClone(current) : null;
    },
    async saveProfile(profile) {
      current = structuredClone(profile);
    },
    snapshot() {
      return current ? structuredClone(current) : null;
    },
  };
}

function walkSource(dir: string, hits: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'storage' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(full, hits);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|py)$/.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
      if (/\b(exec|execSync|execFile|spawn|spawnSync)\s*\(/.test(lines[index]) || /shell:\s*true/.test(lines[index])) {
        hits.push(`${path.relative(repoRoot, full)}:${index + 1}:${trimmed}`);
      }
    }
  }
}

test('role and location are separate argv entries, not one shell command', () => {
  const { args } = buildJobspyArgs(
    ["O'Brien", 'C++ Engineer'],
    ['Berlin, Germany', "O'Hare"],
    4,
    336,
  );
  assert.deepEqual(args.slice(0, 4), ['--search', "O'Brien", '--location', 'Berlin, Germany']);
  assert.equal(args[args.indexOf('--searches') + 1], JSON.stringify(['C++ Engineer']));
  assert.equal(args[args.indexOf('--locations') + 1], JSON.stringify(["O'Hare"]));
  assert.equal(args.some((arg) => arg.includes('python3') || arg.includes('&&') || arg.includes('| sh')), false);
  const runnerSource = fs.readFileSync(path.join(repoRoot, 'src/modules/harvester/jobspy-runner.ts'), 'utf8');
  assert.match(runnerSource, /execFile\s*\(/);
  assert.equal(/\bexec\s*\(/.test(runnerSource), false);
  assert.match(runnerSource, /maxBuffer:\s*SCRAPE_MAX_BUFFER_BYTES/);
  assert.match(runnerSource, /timeout:\s*SCRAPE_TIMEOUT_MS/);
  assert.match(runnerSource, /shell:\s*false/);
});

test('injection payloads do not create files and reach Python as literal argv', async () => {
  clearSentinels();
  const argvOut = path.join(os.tmpdir(), `rg002-argv-${process.pid}.json`);
  fs.rmSync(argvOut, { force: true });
  try {
    const jobs = await JobspyRunner.scrape(
      [QUOTE_BREAK, DOLLAR, BACKTICK, NEWLINE_ROLE],
      [NEWLINE_LOCATION, 'Remote'],
      1,
      1,
      {
        scriptPath: stubScript,
        env: { JOBSPY_ARGV_OUT: argvOut },
      },
    );
    assert.deepEqual(jobs, []);
    assertSentinelsAbsent();
    const recorded = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as { script: string; argv: string[]; executable: string };
    assert.equal(recorded.executable.includes('python'), true);
    assert.equal(recorded.script, stubScript);
    assert.equal(recorded.argv[recorded.argv.indexOf('--search') + 1], QUOTE_BREAK);
    const extra = JSON.parse(recorded.argv[recorded.argv.indexOf('--searches') + 1]) as string[];
    assert.deepEqual(extra, [DOLLAR, BACKTICK, NEWLINE_ROLE]);
    assert.equal(recorded.argv[recorded.argv.indexOf('--location') + 1], NEWLINE_LOCATION);
    assert.equal(recorded.argv.includes('sh'), false);
    assert.equal(recorded.argv.includes('-c'), false);
  } finally {
    fs.rmSync(argvOut, { force: true });
    clearSentinels();
  }
});

test('the real wrapper receives injection text without running it', () => {
  clearSentinels();
  const result = spawnSync('python3', [
    wrapperScript,
    '--search', QUOTE_BREAK,
    '--searches', JSON.stringify([DOLLAR, BACKTICK, NEWLINE_ROLE]),
    '--location', NEWLINE_LOCATION,
    '--locations', JSON.stringify(['Remote']),
    '--sites', 'indeed',
    '--limit', '1',
    '--hours', '1',
    '--country', 'worldwide',
  ], { encoding: 'utf8', cwd: repoRoot });

  assertSentinelsAbsent();
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as { error?: string };
  assert.match(parsed.error || '', /python-jobspy is not installed/);
  assert.equal((result.stderr || '').includes('usage:'), false);
  clearSentinels();
});

test('apostrophes, quotes, and leading dashes stay intact as argv', async () => {
  const argvOut = path.join(os.tmpdir(), `rg002-honest-${process.pid}.json`);
  fs.rmSync(argvOut, { force: true });
  try {
    const jobs = await JobspyRunner.scrape(
      ["O'Brien", 'C++ Engineer'],
      ['Berlin, Germany'],
      2,
      24,
      { scriptPath: stubScript, env: { JOBSPY_ARGV_OUT: argvOut, JOBSPY_EMIT_JOB: '1' } },
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Backend Engineer');
    assert.equal(jobs[0].company, 'Example');
    assert.equal(jobs[0].applyUrl, 'https://example.com/jobs/1');
    const recorded = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as { argv: string[] };
    assert.equal(recorded.argv[recorded.argv.indexOf('--search') + 1], "O'Brien");
    assert.equal(
      JSON.parse(recorded.argv[recorded.argv.indexOf('--searches') + 1])[0],
      'C++ Engineer',
    );
    assert.equal(recorded.argv[recorded.argv.indexOf('--location') + 1], 'Berlin, Germany');
  } finally {
    fs.rmSync(argvOut, { force: true });
  }
});

test('leading-dash roles are data for the real argparse wrapper', () => {
  const result = spawnSync('python3', [
    wrapperScript,
    '--search', '--help',
    '--location', '-n',
    '--sites', 'indeed',
    '--limit', '1',
    '--hours', '1',
    '--country', 'worldwide',
  ], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as { error?: string };
  assert.match(parsed.error || '', /python-jobspy is not installed/);
});

test('invalid profile bodies are rejected and do not write', async () => {
  const original = validProfile();
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'oversized role', body: { ...original, targetRoles: ['R'.repeat(81)] } },
    { name: 'oversized location', body: { ...original, targetLocations: ['L'.repeat(81)] } },
    { name: 'oversized home location', body: { ...original, location: 'L'.repeat(81) } },
    { name: 'control character', body: { ...original, targetRoles: ['bad\u0001role'] } },
    { name: 'newline in role', body: { ...original, targetRoles: ['bad\nrole'] } },
    { name: 'newline in location', body: { ...original, targetLocations: ['Berlin\nGermany'] } },
    { name: 'empty target roles', body: { ...original, targetRoles: [] } },
    { name: 'empty target locations', body: { ...original, targetLocations: [] } },
    { name: 'blank role', body: { ...original, targetRoles: ['   '] } },
    { name: 'unknown field', body: { ...original, shellCommand: 'touch /tmp/pwned-rg002' } },
    { name: 'non-string role', body: { ...original, targetRoles: [12] } },
    { name: 'not an object', body: ['not', 'a', 'profile'] },
    { name: 'null body', body: null },
  ];

  for (const sample of cases) {
    const store = memoryStore(original);
    const before = await store.getProfile();
    const result = await applyProfileUpdate(sample.body, store);
    assert.equal(result.ok, false, sample.name);
    if (!result.ok) assert.equal(result.status, 400, sample.name);
    assert.deepEqual(await store.getProfile(), before, sample.name);
    assert.deepEqual(store.snapshot(), before, sample.name);
  }
});

test('honest profile values including apostrophes are stored trimmed', async () => {
  const store = memoryStore(null);
  const body = validProfile({
    name: '  O\'Brien  ',
    targetRoles: ["  O'Brien  ", 'C++ Engineer'],
    targetLocations: ['  Berlin, Germany  '],
    professionalSummary: 'Line one.\nLine two.',
  });
  const result = await applyProfileUpdate(body, store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.profile.name, "O'Brien");
  assert.deepEqual(result.profile.targetRoles, ["O'Brien", 'C++ Engineer']);
  assert.deepEqual(result.profile.targetLocations, ['Berlin, Germany']);
  assert.match(result.profile.professionalSummary || '', /Line one\.\nLine two\./);
  assert.equal(store.snapshot()?.targetRoles[0], "O'Brien");
});

test('repo has no shell spawn of user-controlled command strings', () => {
  const hits: string[] = [];
  walkSource(repoRoot, hits);
  const unexpected = hits.filter((hit) => {
    if (hit.includes('docs/review-guides/')) return false;
    if (hit.includes('tests/review-guide-002.test.ts')) return false;
    if (/\.exec\s*\(/.test(hit)) return false;
    if (hit.includes('jobspy-runner.ts') && hit.includes('execFile(')) return false;
    return true;
  });
  assert.deepEqual(unexpected, []);
  assert.equal(hits.some((hit) => /shell:\s*true/.test(hit)), false);
});

test('parse-local route file and callers are gone', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src/app/api/profile/parse-local/route.ts')),
    false,
  );
  const scanned: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'storage', 'docs', 'tests'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|html|md|py)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('/api/profile/parse-local') || text.includes('resume-local-path')) {
        scanned.push(path.relative(repoRoot, full));
      }
    }
  };
  walk(repoRoot);
  assert.deepEqual(scanned, []);
});

async function waitForHttp(url: string, timeoutMs = 40000) {
  const started = Date.now();
  let lastError = 'not started';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function startProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
  return {
    child,
    logs: () => logs,
    stop() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
  };
}

test('express rejects invalid updates and parse-local is 404', { timeout: 60000 }, async () => {
  const port = 4317;
  const dbPath = path.join(repoRoot, 'storage/temp/db.json');
  const backup = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const secret = `RG002_SECRET_${process.pid}`;
  const secretFile = path.join(os.tmpdir(), `rg002-secret-${process.pid}.txt`);
  fs.writeFileSync(secretFile, secret);
  const server = startProcess('yarn', ['tsx', 'src/index.ts'], {
    ...process.env,
    PORT: String(port),
  });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/profile`);
    const before = await fetch(`http://127.0.0.1:${port}/api/profile`);
    const beforeText = await before.text();

    const rejected = await fetch(`http://127.0.0.1:${port}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validProfile(), targetRoles: ['bad\nrole'] }),
    });
    assert.equal(rejected.status, 400);
    const afterReject = await fetch(`http://127.0.0.1:${port}/api/profile`);
    assert.equal(await afterReject.text(), beforeText);

    const saved = await fetch(`http://127.0.0.1:${port}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validProfile({ targetRoles: ["O'Brien", 'C++ Engineer'] })),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { profile: CandidateProfile };
    assert.deepEqual(savedBody.profile.targetRoles, ["O'Brien", 'C++ Engineer']);

    const stored = await (await fetch(`http://127.0.0.1:${port}/api/profile`)).json() as CandidateProfile;
    const oversized = await fetch(`http://127.0.0.1:${port}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stored, targetLocations: ['Z'.repeat(90)] }),
    });
    assert.equal(oversized.status, 400);
    const still = await (await fetch(`http://127.0.0.1:${port}/api/profile`)).json() as CandidateProfile;
    assert.deepEqual(still.targetRoles, ["O'Brien", 'C++ Engineer']);
    assert.equal(JSON.stringify(still).includes('Z'.repeat(90)), false);

    const stolen = await fetch(`http://127.0.0.1:${port}/api/profile/parse-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPath: secretFile }),
    });
    const stolenText = await stolen.text();
    assert.equal(stolen.status, 404);
    assert.equal(stolenText.includes(secret), false);
    const profileAfter = await (await fetch(`http://127.0.0.1:${port}/api/profile`)).text();
    assert.equal(profileAfter.includes(secret), false);
  } catch (err) {
    console.error(server.logs());
    throw err;
  } finally {
    server.stop();
    fs.rmSync(secretFile, { force: true });
    if (backup) fs.writeFileSync(dbPath, backup);
    else fs.rmSync(dbPath, { force: true });
  }
});

test('next parse-local is 404, invalid updates do not write, and upload still parses', { timeout: 120000 }, async () => {
  if (!fs.existsSync(path.join(repoRoot, '.next/BUILD_ID'))) {
    throw new Error('Next build is missing. Run yarn build before this test.');
  }

  const port = 4318;
  const dbPath = path.join(repoRoot, 'storage/temp/db.json');
  const backup = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const secret = `RG002_NEXT_SECRET_${process.pid}`;
  const secretFile = path.join(os.tmpdir(), `rg002-next-secret-${process.pid}.txt`);
  fs.writeFileSync(secretFile, secret);

  const docxPath = path.join(os.tmpdir(), `rg002-resume-${process.pid}.docx`);
  const docx = spawnSync('python3', ['-c', `
import zipfile, sys
path = sys.argv[1]
files = {
  "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
  "_rels/.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
  "word/document.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Makinde Akinola</w:t></w:r></w:p>
    <w:p><w:r><w:t>Senior Full-Stack Engineer</w:t></w:r></w:p>
    <w:p><w:r><w:t>Lagos, Nigeria</w:t></w:r></w:p>
    <w:p><w:r><w:t>makinde@example.com</w:t></w:r></w:p>
    <w:p><w:r><w:t>+234 800 000 0000</w:t></w:r></w:p>
    <w:p><w:r><w:t>React, Node.js, TypeScript</w:t></w:r></w:p>
  </w:body>
</w:document>""",
}
with zipfile.ZipFile(path, "w") as archive:
    for name, content in files.items():
        archive.writestr(name, content)
`, docxPath], { encoding: 'utf8' });
  assert.equal(docx.status, 0, docx.stderr);

  const server = startProcess('yarn', ['start', '-p', String(port)], { ...process.env });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/profile`, 60000);
    const before = await (await fetch(`http://127.0.0.1:${port}/api/profile`)).text();

    const rejected = await fetch(`http://127.0.0.1:${port}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validProfile(), targetRoles: ['bad\u0007role'] }),
    });
    assert.equal(rejected.status, 400);
    const afterReject = await (await fetch(`http://127.0.0.1:${port}/api/profile`)).text();
    assert.equal(afterReject, before);

    const malformed = await fetch(`http://127.0.0.1:${port}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/profile`)).text(), before);

    const stolen = await fetch(`http://127.0.0.1:${port}/api/profile/parse-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPath: secretFile }),
    });
    const stolenText = await stolen.text();
    assert.equal(stolen.status, 404);
    assert.equal(stolenText.includes(secret), false);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/profile`)).text()).includes(secret), false);

    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(docxPath)]), 'resume.docx');
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/profile/upload`, {
      method: 'POST',
      body: form,
    });
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 200, uploadedText);
    const profile = JSON.parse(uploadedText) as CandidateProfile;
    assert.match(profile.name, /MAKINDE AKINOLA|Makinde Akinola/);
    assert.equal(uploadedText.includes(secret), false);
  } catch (err) {
    console.error(server.logs());
    throw err;
  } finally {
    server.stop();
    fs.rmSync(secretFile, { force: true });
    fs.rmSync(docxPath, { force: true });
    if (backup) fs.writeFileSync(dbPath, backup);
    else fs.rmSync(dbPath, { force: true });
  }
});
