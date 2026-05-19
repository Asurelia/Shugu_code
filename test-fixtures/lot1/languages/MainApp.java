// LOT 1 — Java syntax highlighting test.
// Expected: keywords violet, strings teal, comments gray-italic.

package com.shugu.test;

import java.util.List;
import java.util.ArrayList;

public class MainApp {
    private final String greeting;

    public MainApp(String greeting) {
        this.greeting = greeting;
    }

    public List<String> greetAll(List<String> names) {
        List<String> result = new ArrayList<>();
        for (String name : names) {
            result.add(greeting + ", " + name + "!");
        }
        return result;
    }

    public static void main(String[] args) {
        MainApp app = new MainApp("Hello");
        app.greetAll(List.of("Alice", "Bob")).forEach(System.out::println);
    }
}
