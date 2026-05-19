import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { HealthDocumentsController } from './health-documents.controller';
import { HealthDocumentsService } from './health-documents.service';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  ],
  controllers: [HealthDocumentsController],
  providers: [HealthDocumentsService],
})
export class HealthDocumentsModule {}
