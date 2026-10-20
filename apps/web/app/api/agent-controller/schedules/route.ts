// The chat kit asks for the agent's recurring schedules. Locus's agent server has none yet, so
// this answers an empty list here rather than forwarding a request it would refuse with 404.
export function GET() {
  return Response.json({ schedules: [] });
}
