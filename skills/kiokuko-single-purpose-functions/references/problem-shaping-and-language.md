<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.modeling.v1` — problem shaping and representation design

Select this expert when a contract defines a public data shape, introduces
domain vocabulary, or translates between human intent, domain values, storage,
transport, serialization, and consumer or UI representations.

Do not select it for a representation-preserving mechanical change merely
because the work modifies code. This expert does not require Lisp syntax, a
Lisp runtime, macros, a DSL, or a separate design document.

## Contract

Turn the human problem into named concepts and explicit transformations before
letting a database schema, ORM model, framework object, wire format, or UI state
become the accidental product contract.

For a non-trivial selected contract, make these items explicit in the working
plan or review notes, without creating a new artifact unless the user asks:

1. **Intent:** identify the actor, their goal, the observable result, and data
   that must remain hidden or out of scope.
2. **Representation map:** list only the layers that actually exist, using this
   shape as a guide: `human intent -> domain concept -> storage/input shape ->
   public shape -> consumer shape`.
3. **Consumer-first shape:** define what the external caller or next layer
   needs before choosing how to retrieve, serialize, or display it.
4. **Named transformations:** use names that reveal the concept and direction,
   such as `rowToArticle`, `articleToApiResponse`, or
   `apiResponseToArticleViewState`.
5. **Loss and failure policy:** state what is omitted, normalized, derived,
   rejected, or intentionally impossible to reconstruct at each boundary.
6. **Abstraction threshold:** start with direct values and cohesive functions.
   Extract shared vocabulary after meaningful repetition appears; introduce a
   DSL, macro, code generator, or generic framework only when the stable pattern
   and its benefit are evidenced.

## Representation boundaries

- Storage shapes serve persistence and query needs; they are not automatically
  domain or public shapes.
- Domain shapes name legal concepts and invariants without inheriting transport
  or framework accidents.
- Public API and event shapes are compatibility and disclosure contracts. Build
  them from allowlisted fields rather than serializing internal objects.
- Consumer and UI shapes serve rendering and interaction state. Do not force
  components to understand database relations or transport-only nullability.
- Use distinct shapes for distinct audiences when list, detail, administrative,
  and public views carry different concepts or disclosure rules.

Pair this expert with `code.boundary.v1` when the transformation crosses an
untrusted or public boundary. Pair it with `code.domain.v1` when the named shape
owns business states, invariants, or transitions. Stay within the three-expert
limit and select only risks owned by the same cohesive contract.

## Failure modes

- Returning an ORM entity, database row, or framework object directly as a
  public response.
- Treating storage column names or relations as a stable external API by
  accident.
- Reusing one DTO for audiences whose visibility or interaction needs differ.
- Mixing server response state, domain state, and UI state in one mutable type.
- Adding wrappers that rename syntax but create no semantic contract.
- Generalizing one instance into a DSL or metaprogramming layer before stable
  repetition exists.

## Focused verification

Test the observable shape and transformation rather than the current storage or
framework implementation:

- assert the exact allowed public fields and the absence of internal or secret
  fields;
- cover missing, optional, normalized, derived, and rejected values;
- verify intentional information loss or round-trip behavior where relevant;
- prove that a storage-layout or transport-fixture change does not silently
  redefine the public concept;
- test audience-specific shapes independently when their contracts differ.

This guidance adapts the problem-shaping philosophy described in
<https://zenn.dev/circleback/articles/what-is-lisp>; it applies that philosophy
across programming languages and does not reproduce the article text.
