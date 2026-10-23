async function queryLoki(logql, limit = 50) {
  const query = encodeURIComponent(logql);
  const url = `http://127.0.0.1:3100/loki/api/v1/query_range?query=${query}&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function main() {
  const arg = process.argv[2] || 'all';
  let logql = '{app="pos_store"}';
  if (arg === 'node') {
    logql = '{app="pos_store", source="node_backend"}';
  } else if (arg === 'nginx') {
    logql = '{app="pos_store", source="nginx_access"}';
  } else if (arg === 'nginx_error') {
    logql = '{app="pos_store", source="nginx_error"}';
  } else if (arg === 'errors_gte_400') {
    // Truy van ca Node va Nginx voi status >= 400
    logql = '{app="pos_store"} | json | statusCode >= 400';
  } else if (arg.startsWith('{')) {
    logql = arg;
  } else if (arg.includes('-')) {
    // Tim kiem theo requestId
    logql = `{app="pos_store"} |= "${arg}"`;
  }
  
  console.log(`Executing LogQL: ${logql}`);
  const json = await queryLoki(logql);
  if (json.status !== 'success') {
    console.error('Error response from Loki:', json);
    return;
  }
  console.log('Status:', json.status);
  const result = json.data?.result || [];
  console.log(`Streams found: ${result.length}`);
  for (const stream of result) {
    console.log('\n--- STREAM ---');
    console.log('Labels:', stream.stream);
    console.log(`Log lines count: ${stream.values.length}`);
    for (let i = 0; i < Math.min(5, stream.values.length); i++) {
      const [ts, line] = stream.values[i];
      console.log(` [${new Date(Number(ts.slice(0, 13))).toISOString()}] ${line}`);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { queryLoki };
