// SSE frames can span network chunks, including the bytes of accented text.
export async function* readEvents(body) {
  if (!body) throw new Error('O servidor não enviou a resposta.');
  const reader=body.getReader(),decoder=new TextDecoder();
  let buffer='';
  function parse(frame) {
    let event='message';const lines=[];
    for(const line of frame.split(/\r?\n/)) {
      if(line.startsWith('event:'))event=line.slice(6).trim();
      else if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''));
    }
    if(!lines.length)return null;
    try{return {event,data:JSON.parse(lines.join('\n'))};}
    catch{throw new Error('O servidor enviou uma resposta inválida.');}
  }
  try {
    while(true) {
      const {value,done}=await reader.read();
      buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      if(buffer.length>1024*1024)throw new Error('A resposta excedeu o limite de leitura.');
      let match;
      while((match=/\r?\n\r?\n/.exec(buffer))) {
        const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
        const parsed=parse(frame);if(parsed)yield parsed;
      }
      if(done)break;
    }
    if(buffer.trim()){const parsed=parse(buffer);if(parsed)yield parsed;}
  } finally {
    await reader.cancel().catch(()=>{});reader.releaseLock();
  }
}

// `progress` ({etapa}) is optional and informative; unknown events are ignored.
export async function consumeChatEvents(body,onDelta=()=>{},onProgress=()=>{}) {
  for await(const {event,data} of readEvents(body)) {
    if(event==='delta') {
      if(typeof data?.text!=='string')throw new Error('Trecho da resposta inválido.');
      onDelta(data.text);
    } else if(event==='progress') {
      if(typeof data?.etapa==='string')onProgress(data.etapa);
    } else if(event==='error')throw new Error(data?.message||'Não foi possível concluir a resposta.');
    else if(event==='complete') {
      if(!data?.conversationId||typeof data.answer!=='string'||!Array.isArray(data.messages))throw new Error('A conversa não foi confirmada pelo servidor.');
      return data;
    }
  }
  throw new Error('A conexão terminou antes de salvar a resposta. Tente novamente.');
}
