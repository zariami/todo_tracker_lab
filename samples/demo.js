// TODO: добавить обработку пустого массива
function sum(items) {
  let total = 0;
  for (const x of items) {
    total += x;
  }
  return total;
}

/* FIXME: функция падает, если передать null */
function average(items) {
  return sum(items) / items.length;
}

// HACK: временное решение, пока не готов API
const API_URL = 'http://localhost:3000';

console.log(average([1, 2, 3]), API_URL);
