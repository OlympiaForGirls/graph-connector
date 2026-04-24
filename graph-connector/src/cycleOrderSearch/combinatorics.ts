/** Returns all k-element subsets of arr, preserving the original order within each subset. */
export function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const result: T[][] = [];
  function pick(start: number, current: T[]) {
    if (current.length === k) { result.push([...current]); return; }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      pick(i + 1, current);
      current.pop();
    }
  }
  pick(0, []);
  return result;
}

/** Returns all permutations of the indices 0..n-1. */
export function indexPermutations(n: number): number[][] {
  const result: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const current: number[] = [];
  function go() {
    if (current.length === n) { result.push([...current]); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(i);
      go();
      current.pop();
      used[i] = false;
    }
  }
  go();
  return result;
}
