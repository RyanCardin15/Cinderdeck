import * as NodeAssert from "node:assert/strict";
const root = process.env.CINDERDECK_URL_WEB || "http://127.0.0.1:47861";
const first = await fetch(root + "/api/payment?retry=0");
NodeAssert.equal(first.status, 402, "first payment must decline");
const retry = await fetch(root + "/api/payment?retry=1");
NodeAssert.equal(retry.status, 200, "retry must complete after repair");
NodeAssert.equal((await retry.json()).result, "paid");
const stamp = await fetch(root + "/stamp").then((r) => r.json());
NodeAssert.match(stamp.commit, /^[a-f0-9]{40}$/);
NodeAssert.match(stamp.sourceHash, /^[a-f0-9]{64}$/);
console.log(
  "PASS: declined-payment-retry-v1; actual frontend/API responses and served build stamp checked",
);
