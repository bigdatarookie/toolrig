import fs from 'node:fs';
// Open once, reject non-regular/oversized inputs before reading, then enforce
// the cap again on that descriptor in case a regular file grows after fstat.
export function readBoundedJson(path,io=fs) {
  const limit=4096;
  const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
  try {
    const info=io.fstatSync(fd);
    if(!info.isFile()||info.size>limit)throw new Error('input_not_bounded_regular_file');
    const buffer=Buffer.alloc(limit+1);let count=0;
    while(count<buffer.length) {
      const n=io.readSync(fd,buffer,count,buffer.length-count,null);
      if(n===0)break;count+=n;
    }
    if(count>limit)throw new Error('input_exceeds_byte_limit');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count)));
  } finally {io.closeSync(fd);}
}
