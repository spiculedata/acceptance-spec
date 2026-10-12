// A command spec: the exit code is the verdict. ACCEPTANCE_BASE_URL is set only when a server is available.
const base = process.env.ACCEPTANCE_BASE_URL;
if (!base) {
  console.error('ACCEPTANCE_BASE_URL is not set');
  process.exit(1);
}
const res = await fetch(new URL('/api/healthz', base));
if (res.status !== 200) {
  console.error(`expected 200, got ${res.status}`);
  process.exit(1);
}
console.log('healthz ok');
