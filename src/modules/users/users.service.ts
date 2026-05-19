import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  doctorProfiles,
  patientProfiles,
  users,
  type DoctorProfile,
  type PatientProfile,
  type User,
} from '../../database/schema';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';

export type Me = {
  user: Omit<User, 'passwordHash'>;
  profile: PatientProfile | DoctorProfile | null;
};

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  async getMe(userId: string): Promise<Me> {
    const admin = this.db.admin();
    const [user] = await admin.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new CodedException(ErrorCodes.USER_NOT_FOUND);

    const { passwordHash: _passwordHash, ...safeUser } = user;
    void _passwordHash;

    let profile: PatientProfile | DoctorProfile | null = null;
    if (user.role === 'patient') {
      const [p] = await admin
        .select()
        .from(patientProfiles)
        .where(eq(patientProfiles.userId, userId))
        .limit(1);
      profile = p ?? null;
    } else if (user.role === 'doctor') {
      const [d] = await admin
        .select()
        .from(doctorProfiles)
        .where(eq(doctorProfiles.userId, userId))
        .limit(1);
      profile = d ?? null;
    }
    return { user: safeUser, profile };
  }
}
