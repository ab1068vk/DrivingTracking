package com.drivesense.app;

import java.nio.ByteBuffer;
import java.util.Arrays;

/** Portable, deterministic SHA-256 compression state for P5 integrity jobs. */
final class DriveSenseSha256State {
    static final int FORMAT_VERSION = 1;
    private static final int[] INITIAL = {
        0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
        0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
    };
    private static final int[] K = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    };

    private final int[] words;
    private final byte[] partial;
    private int partialLength;
    private long byteCount;

    DriveSenseSha256State() { words = INITIAL.clone(); partial = new byte[64]; }

    static DriveSenseSha256State restore(byte[] state, long byteCount, byte[] partialBytes) {
        if (state == null || state.length != 32 || byteCount < 0 || partialBytes == null || partialBytes.length >= 64 ||
            (byteCount & 63L) != partialBytes.length) throw new IllegalArgumentException("Invalid SHA-256 midstate");
        DriveSenseSha256State digest = new DriveSenseSha256State();
        ByteBuffer buffer = ByteBuffer.wrap(state);
        for (int i=0;i<8;i++) digest.words[i]=buffer.getInt();
        System.arraycopy(partialBytes,0,digest.partial,0,partialBytes.length);
        digest.partialLength=partialBytes.length;
        digest.byteCount=byteCount;
        return digest;
    }

    DriveSenseSha256State update(byte[] input) { return update(input,0,input.length); }

    DriveSenseSha256State update(byte[] input,int offset,int length) {
        if(input==null||offset<0||length<0||offset+length>input.length)throw new IllegalArgumentException("Invalid SHA input");
        byteCount+=length;
        while(length>0){
            int copy=Math.min(length,64-partialLength);
            System.arraycopy(input,offset,partial,partialLength,copy);
            partialLength+=copy;offset+=copy;length-=copy;
            if(partialLength==64){compress(partial);partialLength=0;}
        }
        return this;
    }

    byte[] chainingState(){ByteBuffer b=ByteBuffer.allocate(32);for(int word:words)b.putInt(word);return b.array();}
    byte[] partialBlock(){return Arrays.copyOf(partial,partialLength);}
    long byteCount(){return byteCount;}

    byte[] digest(){
        DriveSenseSha256State copy=restore(chainingState(),byteCount,partialBlock());
        long bits=copy.byteCount*8L;
        copy.update(new byte[]{(byte)0x80});
        byte[] zero=new byte[64];
        int pad=(copy.partialLength<=56?56-copy.partialLength:64+56-copy.partialLength);
        if(pad>0)copy.update(zero,0,pad);
        byte[] length=ByteBuffer.allocate(8).putLong(bits).array();
        copy.update(length);
        return copy.chainingState();
    }

    private void compress(byte[] block){
        int[] w=new int[64];ByteBuffer b=ByteBuffer.wrap(block);
        for(int i=0;i<16;i++)w[i]=b.getInt();
        for(int i=16;i<64;i++){int a=w[i-15],z=w[i-2];int s0=Integer.rotateRight(a,7)^Integer.rotateRight(a,18)^(a>>>3);int s1=Integer.rotateRight(z,17)^Integer.rotateRight(z,19)^(z>>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
        int a=words[0],c=words[2],d=words[3],e=words[4],f=words[5],g=words[6],h=words[7],bb=words[1];
        for(int i=0;i<64;i++){int s1=Integer.rotateRight(e,6)^Integer.rotateRight(e,11)^Integer.rotateRight(e,25);int ch=(e&f)^(~e&g);int t1=h+s1+ch+K[i]+w[i];int s0=Integer.rotateRight(a,2)^Integer.rotateRight(a,13)^Integer.rotateRight(a,22);int maj=(a&bb)^(a&c)^(bb&c);int t2=s0+maj;h=g;g=f;f=e;e=d+t1;d=c;c=bb;bb=a;a=t1+t2;}
        words[0]+=a;words[1]+=bb;words[2]+=c;words[3]+=d;words[4]+=e;words[5]+=f;words[6]+=g;words[7]+=h;
        Arrays.fill(w,0);
    }
}
