async function test() {
  const res = await fetch('http://127.0.0.1:3030/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', email: '', password: 'admin' })
  });
  console.log('Status:', res.status);
  console.log('Headers:', res.headers.get('set-cookie'));
  const text = await res.text();
  console.log('Body:', text);
}
test();
