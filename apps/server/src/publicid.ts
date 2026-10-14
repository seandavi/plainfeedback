// Participant URL id: 12 chars of lowercase Crockford base32 from WebCrypto (60 random bits).
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const PUBLIC_ID = /^[0-9a-z]{12}$/;
export const newPublicId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ALPHABET[b % 32]).join("");
