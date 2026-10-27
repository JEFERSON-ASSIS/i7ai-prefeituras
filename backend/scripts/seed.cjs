const {PrismaClient}=require('@prisma/client');
const {ROLE_NAMES,ensureRolePermissions}=require('./permissions.cjs');
const {existsSync}=require('node:fs');
if(existsSync('../.env'))process.loadEnvFile('../.env');
if(process.env.NODE_ENV==='production')throw new Error('O seed demonstrativo deve ser executado somente no desenvolvimento.');
const prisma=new PrismaClient();
async function seed(){
  const tenant=await prisma.tenant.upsert({where:{slug:'dev-prefeitura'},update:{},create:{id:'00000000-0000-0000-0000-000000000001',slug:'dev-prefeitura',name:'Prefeitura de Desenvolvimento'}});
  const admin=await prisma.user.upsert({where:{email:'admin@i7ai.gov.br'},update:{},create:{tenantId:tenant.id,name:'Administrador de Desenvolvimento',email:'admin@i7ai.gov.br',status:'ACTIVE'}});
  for(const name of ROLE_NAMES){
    const role=await prisma.role.upsert({where:{name},update:{},create:{name}});
    await ensureRolePermissions(prisma,role.id,name);
    if(name==='ADMIN')await prisma.userRole.upsert({where:{userId_roleId:{userId:admin.id,roleId:role.id}},update:{},create:{userId:admin.id,roleId:role.id}});
  }
  const provider=await prisma.aiProvider.upsert({where:{slug:'openai'},update:{},create:{name:'OpenAI',slug:'openai'}});
  const model=process.env.OPENAI_MODEL||'gpt-4o-mini';
  await prisma.aiModel.upsert({where:{providerId_slug:{providerId:provider.id,slug:model}},update:{},create:{providerId:provider.id,name:model,slug:model}});
  // Local standalone departments (no SGDM setor): names are no longer unique in the schema, so look them up first.
  for(const name of ['Administração','Jurídico','Compras'])if(!await prisma.department.findFirst({where:{tenantId:tenant.id,name,externalId:null}}))await prisma.department.create({data:{tenantId:tenant.id,name}});
  if(!await prisma.license.findFirst({where:{tenantId:tenant.id}}))await prisma.license.create({data:{tenantId:tenant.id,maxUsers:10,maxAgents:10,maxAutomations:10,maxKnowledgeBases:10,maxTokens:1000000n}});
  console.log('Catálogo, perfis e acesso de desenvolvimento inicializados.');
}
seed().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
