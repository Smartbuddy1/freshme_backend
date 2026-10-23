import {z} from 'zod';

// bcrypt only uses the first 72 UTF-8 bytes. Reject new passwords that it
// would silently truncate; existing credentials remain valid at login.
export const passwordLength=z.string().min(12).max(128).refine(
  value=>Buffer.byteLength(value,'utf8')<=72,
  'Password must be at most 72 UTF-8 bytes (use fewer characters)'
);
export const passwordInput=passwordLength.refine(
  value=>/[a-z]/.test(value)&&/[A-Z]/.test(value)&&/\d/.test(value)&&/[^\w\s]/.test(value),
  'Use upper/lowercase, a number and a symbol'
);
