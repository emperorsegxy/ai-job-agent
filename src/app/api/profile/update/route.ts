import { NextRequest, NextResponse } from 'next/server';
import { dbService } from '../../../../config/firebase';
import { applyProfileUpdate } from '../../../../modules/cv-parser/profile-update';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const result = await applyProfileUpdate(body, dbService);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ message: 'Profile updated successfully.', profile: result.profile });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
