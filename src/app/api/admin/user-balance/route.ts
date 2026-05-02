import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken, unauthorizedResponse } from '@/lib/admin-auth';
import { getUser } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
  if (!(await verifyAdminToken(request))) return unauthorizedResponse(request);

  const userId = Number(request.nextUrl.searchParams.get('userId'));
  if (!Number.isFinite(userId) || !Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: 'Invalid userId' }, { status: 400 });
  }

  try {
    const user = await getUser(userId);
    return NextResponse.json({ balance: user.balance });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch user balance' }, { status: 500 });
  }
}
