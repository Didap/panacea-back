import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @Length(6, 6)
  otp!: string;

  @IsOptional()
  @IsBoolean()
  canSubDelegate?: boolean;
}
