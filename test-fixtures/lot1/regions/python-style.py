# LOT 1 — Region folding test: hash-style # region.
# Used by Python / Ruby / YAML / Dockerfile.
# Click the fold gutter on the `# region` line to collapse the body.

# region Helpers
def add(a, b):
    return a + b

def multiply(a, b):
    return a * b

def divide(a, b):
    if b == 0:
        raise ValueError("division by zero")
    return a / b
# endregion

# region Main
def main():
    print(add(1, 2))
    print(multiply(3, 4))
    print(divide(10, 2))
# endregion

if __name__ == "__main__":
    main()
