// Ensures the S3 bucket exists (HeadBucket, CreateBucket on 404). On the VPS the bucket is
// pre-created and the app user cannot create buckets, so a missing bucket fails closed.
// Same env names and client options as backend/src (MinIO needs path style).
const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET ?? 'i7ai-documents';
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'i7ai',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'i7ai_dev_minio',
  },
});

async function main() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[bucket] ${bucket} ja existe.`);
    return;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') throw error;
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`[bucket] ${bucket} criado.`);
}

main().catch((error) => {
  console.error(`[bucket] erro ao garantir ${bucket}: ${error?.name ?? ''} ${error?.message ?? error}`);
  process.exit(1);
});
