// The issuer key's rotation steps (README "Rotating the issuer key"), used
// by issuer-keys.mjs `rotate`. No Node-only imports, so the Worker's tests
// import it too (test/issuer.test.ts).

// One step of rotating the issuer key (README "Rotating the issuer key"):
// old and new public keys stay published together until the old one is
// retired. Returns the new ISSUER_KEYS value.
export function rotateIssuerKeys(current, step, newKey) {
  const keys = current.keys;
  if (step === "publish") {
    if (keys.length !== 1) throw new Error("a rotation is already under way: finish it with sign and retire first");
    if (!newKey) throw new Error("publish needs a new key");
    return { signing: current.signing, keys: [...keys, newKey] };
  }
  if (step === "sign") {
    const other = keys.find((k) => k.kid !== current.signing);
    if (keys.length !== 2 || !other) throw new Error("sign needs exactly two keys: publish the new one first");
    return { signing: other.kid, keys };
  }
  if (step === "retire") {
    if (keys.length < 2) throw new Error("nothing to retire: only the signing key is published");
    return { signing: current.signing, keys: keys.filter((k) => k.kid === current.signing) };
  }
  throw new Error("the step is publish, sign or retire");
}
