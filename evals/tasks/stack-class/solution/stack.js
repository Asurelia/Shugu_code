class Stack {
  #items = [];

  push(x) {
    this.#items.push(x);
    return this.#items.length;
  }

  pop() {
    return this.#items.pop();
  }

  peek() {
    return this.#items[this.#items.length - 1];
  }

  size() {
    return this.#items.length;
  }

  isEmpty() {
    return this.#items.length === 0;
  }
}

module.exports = { Stack };
