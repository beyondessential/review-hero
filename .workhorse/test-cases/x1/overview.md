# Earlier rejections test cases

## Reading

- [ ] No findings URL, or a non-https one, makes no request and mints no token (verifies spec: REJ)
- [ ] The read is a GET with `pr` and `limit=200`, carrying the identity token as bearer (verifies spec: REJ)
- [ ] A 5xx or no answer is tried once more; a 4xx is not (verifies spec: REJ)
- [ ] A same-origin 307/308 is followed; a cross-origin one is refused (verifies spec: REJ)
- [ ] A 200 that is not a schemaVersion 1 object with a rejections list reads as `malformed` (verifies spec: CMPL)
- [ ] A rejection with the wrong shape is left out and the rest are kept (verifies spec: REJ)
- [ ] No identity token reads as `no-token` (verifies spec: CMPL)
- [ ] The log names the receiver by origin alone (verifies spec: REJ)

## Matching

- [ ] A finding in a file no rejection names is kept without a model call (verifies spec: REJ)
- [ ] A pathless rejection never matches a finding with a file (verifies spec: REJ)
- [ ] An agent's rejection is never offered against a critical; a person's is (verifies spec: REJ)
- [ ] A finding the model picks is dropped; a failed or unreadable reply keeps every finding in the batch (verifies spec: REJ)
- [ ] With no model caller every finding is kept (verifies spec: REJ)
- [ ] Rejection text and reason reach the prompt sanitised, on one line (verifies spec: REJ)

## Reporting

- [ ] `counts.rejected` is the number dropped, 0 by default (verifies spec: CMPL)
- [ ] The summary's filtering line says "N rejected earlier" when any were dropped (verifies spec: REJ)
