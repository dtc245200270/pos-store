async function test() {
  const authHeader = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const res = await fetch('http://127.0.0.1:3030/api/users', {
    headers: { 'Authorization': authHeader }
  });
  console.log('API /api/users Status:', res.status);
  const data = await res.json();
  console.log('Users:', data);
}
test();
