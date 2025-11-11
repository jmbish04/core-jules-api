/**
 * @file src/utils/base64.ts
 * @description This file contains base64 encoding and decoding utilities that correctly handle Unicode.
 * @owner AI-Builder
 */

/**
 * Encodes a string to base64, correctly handling Unicode characters.
 * @param {string} str - The string to encode.
 * @returns {string} The base64-encoded string.
 */
export const encode = (str: string): string => {
  // btoa doesn't handle Unicode characters correctly on its own.
  // The common workaround is to convert the string to a UTF-8 string of characters
  // that btoa can handle.
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    console.error('Failed to base64 encode string:', e);
    // Re-throw the error to prevent incorrect encoding from being used.
    throw e;
  }
}

/**
 * Decodes a base64 string, correctly handling Unicode characters.
 * @param {string} str - The base64 string to decode.
 * @returns {string} The decoded string.
 */
export const decode = (str: string): string => {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    console.error('Failed to base64 decode string:', e);
    // Fallback for safety.
    return atob(str);
  }
}

/**
 * @extension_point
 * This is a good place to add other encoding/decoding functions.
 */
