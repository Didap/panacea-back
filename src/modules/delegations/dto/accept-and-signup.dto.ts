import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AcceptAndSignupDto {
  @IsString()
  @Length(6, 6)
  otp!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsOptional()
  @IsBoolean()
  canSubDelegate?: boolean;
}
