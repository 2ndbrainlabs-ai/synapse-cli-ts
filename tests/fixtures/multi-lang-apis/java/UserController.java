package com.example.api;

import org.springframework.web.bind.annotation.*;
import java.util.List;

/**
 * REST API for user management.
 */
@RestController
@RequestMapping("/api/v1")
public class UserController {

    @GetMapping("/users")
    public List<User> getAllUsers() {
        return List.of();
    }

    @GetMapping("/users/{id}")
    public User getUserById(@PathVariable Long id) {
        return new User(id, "John");
    }

    @PostMapping("/users")
    public User createUser(@RequestBody User user) {
        return user;
    }

    @PutMapping("/users/{id}")
    public User updateUser(@PathVariable Long id, @RequestBody User user) {
        return user;
    }

    @DeleteMapping("/users/{id}")
    public void deleteUser(@PathVariable Long id) {
        // delete user
    }

    record User(Long id, String name) {}
}
