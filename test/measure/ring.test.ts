import assert from "node:assert/strict";
import { test } from "node:test";
import { Ring } from "../../src/measure/ring.ts";

test("the ring keeps the newest items in order and counts what it discarded", () => {
  const ring = new Ring<number>(4);
  for (let i = 1; i <= 10; i++) ring.push(i);
  assert.equal(ring.size, 4);
  assert.equal(ring.discarded, 6);
  assert.deepEqual(ring.toArray(), [7, 8, 9, 10]);
  assert.equal(ring.oldest(), 7);
  assert.equal(ring.newest(), 10);
  assert.equal(ring.at(4), undefined);
});

test("a cleared ring starts empty with no discard history", () => {
  const ring = new Ring<number>(2);
  for (let i = 0; i < 5; i++) ring.push(i);
  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.discarded, 0);
  ring.push(9);
  assert.deepEqual(ring.toArray(), [9]);
});
