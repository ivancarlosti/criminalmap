#!/usr/bin/env node
'use strict';

/**
 * Password hashing helper for ADMIN_PASSWORD entries.
 *
 * Usage:
 *   npm run hash-password -- "my secret"
 *   node src/cli/hash-password.js "my secret"
 *
 * The generated value can be pasted directly into ADMIN_PASSWORD (it contains
 * "$" characters, so wrap it in single quotes when it is one of several entries).
 */

const { hashPassword } = require('../auth');

const password = process.argv.slice(2).join(' ');

if (password.trim() === '') {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}

console.log(hashPassword(password));
