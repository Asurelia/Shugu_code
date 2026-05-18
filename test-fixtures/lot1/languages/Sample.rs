// LOT 1 — Rust syntax highlighting test.
// Expected: keywords violet, strings teal, comments gray-italic.

use std::collections::HashMap;

pub struct User {
    pub name: String,
    pub age: u32,
}

impl User {
    pub fn new(name: &str, age: u32) -> Self {
        Self { name: name.to_string(), age }
    }

    pub fn greet(&self) -> String {
        format!("Hello {}, age {}", self.name, self.age)
    }
}

fn main() {
    let mut users: HashMap<String, User> = HashMap::new();
    users.insert("alice".into(), User::new("Alice", 30));
    if let Some(u) = users.get("alice") {
        println!("{}", u.greet());
    }
}
