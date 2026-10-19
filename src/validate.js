import { HttpError } from './errors.js';

export const STATUSES = ['todo', 'doing', 'done'];
export const ROLES = ['owner', 'member', 'supervisor'];

export function text(value, field, { max = 200, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return trimmed;
}

export function email(value) {
  const v = text(value, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'Enter a valid email address.');
  return v;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  return value;
}

export function oneOf(value, list, field) {
  if (!list.includes(value)) throw new HttpError(400, `${field} must be one of: ${list.join(', ')}.`);
  return value;
}

export function date(value, field = 'Due date') {
  if (value === null || value === '' || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be a date like 2026-10-31.`);
  }
  return value;
}

export function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a positive whole number.`);
  return n;
}
