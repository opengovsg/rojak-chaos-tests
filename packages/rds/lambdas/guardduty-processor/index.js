export function handler(event, context, callback) {
  if (!event.Findings)
    throw new Error('Invariant')

  let triggered = false

  for (const finding of event.Findings) {
    if (finding.Type !== 'CredentialAccess:RDS/AnomalousBehavior.SuccessfulLogin')
      continue

    if (!finding.Service?.EventLastSeen)
      continue

    const lastSeen = new Date(finding.Service?.EventLastSeen)

    const now = new Date(Date.now())
    const fifteenMinutesBefore = new Date(now)
    fifteenMinutesBefore.setMinutes(now.getMinutes() - 15)

    if (lastSeen < fifteenMinutesBefore)
      continue

    triggered = true
    break
  }

  callback(null, { triggered })
}
