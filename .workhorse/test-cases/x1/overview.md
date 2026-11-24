# Earlier rejections test cases

## Reading

- [x] No findings URL, or a non-https one, makes no request and mints no token (verifies spec: REJ)
- [x] The read is a GET with `pr` and `limit=200`, carrying the identity token as bearer (verifies spec: REJ)
- [x] A 5xx or no answer is tried once more; a 4xx is not (verifies spec: REJ)
- [x] A same-origin 307/308 is followed; a cross-origin one is refused (verifies spec: REJ)
- [x] A 200 that is not a schemaVersion 1 object with a rejections list reads as `malformed` (verifies spec: CMPL)
- [x] A rejection with the wrong shape is left out and the rest are kept (verifies spec: REJ)
- [x] No identity token reads as `no-token` (verifies spec: CMPL)
- [x] The log names the receiver by origin alone (verifies spec: REJ)

## Matching

- [x] A finding in a file no rejection names is kept without a model call (verifies spec: REJ)
- [x] A pathless rejection never matches a finding with a file (verifies spec: REJ)
- [x] An agent's rejection is never offered against a critical; a person's is (verifies spec: REJ)
- [x] A finding the model picks is dropped; a failed or unreadable reply keeps every finding in the batch (verifies spec: REJ)
- [x] With no model caller every finding is kept (verifies spec: REJ)
- [x] Rejection text and reason reach the prompt sanitised, on one line (verifies spec: REJ)

## Reporting

- [x] `counts.rejected` is the number dropped, 0 by default (verifies spec: CMPL)
- [x] The summary's filtering line says "N rejected earlier" when any were dropped (verifies spec: REJ)
