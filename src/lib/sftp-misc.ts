﻿import packet = require("./sftp-packet");
import api = require("./fs-api");
import enums = require("./sftp-enums");

import SftpPacket = packet.SftpPacket;
import SftpPacketWriter = packet.SftpPacketWriter;
import SftpPacketReader = packet.SftpPacketReader;
import SftpPacketType = enums.SftpPacketType;
import SftpStatusCode = enums.SftpStatusCode;
import SftpOpenFlags = enums.SftpOpenFlags;
import IItem = api.IItem;
import IStats = api.IStats;
import FileType = api.FileType;

export class SftpFlags {

    static toNumber(flags: string): SftpOpenFlags {
        if (typeof flags === 'number')
            return (<SftpOpenFlags><any>flags) & SftpOpenFlags.ALL;

        switch (flags) {
            case 'r':
                return SftpOpenFlags.READ;
            case 'r+':
                return SftpOpenFlags.READ | SftpOpenFlags.WRITE;
            case 'w':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.TRUNC;
            case 'w+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.TRUNC | SftpOpenFlags.READ;
            case 'wx':
            case 'xw':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.EXCL;
            case 'wx+':
            case 'xw+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.EXCL | SftpOpenFlags.READ;
            case 'a':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND;
            case 'a+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.READ;
            case 'ax':
            case 'xa':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.EXCL;
            case 'ax+':
            case 'xa+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.EXCL | SftpOpenFlags.READ;
            default:
                throw Error("Invalid flags '" + flags + "'");
        }
    }

    static fromNumber(flags: number): string[]{
        flags &= SftpOpenFlags.ALL;

        // 'truncate' does not apply when creating a new file
        if ((flags & SftpOpenFlags.EXCL) != 0)
            flags &= SftpOpenFlags.ALL ^ SftpOpenFlags.TRUNC;

        // 'append' does not apply when truncating
        if ((flags & SftpOpenFlags.TRUNC) != 0)
            flags &= SftpOpenFlags.ALL ^ SftpOpenFlags.APPEND;

        // 'read' or 'write' must be specified (or both)
        if ((flags & (SftpOpenFlags.READ | SftpOpenFlags.WRITE)) == 0)
            flags |= SftpOpenFlags.READ;

        // when not creating a new file, only 'read' or 'write' applies
        // (and when creating a new file, 'write' is required)
        if ((flags & SftpOpenFlags.CREATE) == 0)
            flags &= SftpOpenFlags.READ | SftpOpenFlags.WRITE;
        else
            flags |= SftpOpenFlags.WRITE;

        switch (flags) {
            case 1: return ["r"];
            case 2:
            case 3: return ["r+"];
            case 10: return ["wx", "r+"];
            case 11: return ["wx+", "r+"];
            case 14: return ["a"];
            case 15: return ["a+"];
            case 26: return ["w"];
            case 27: return ["w+"];
            case 42: return ["wx"];
            case 43: return ["wx+"];
            case 46: return ["ax"];
            case 47: return ["ax+"];
        }

        // this will never occur
        throw Error("Unsupported flags");
    }
}

export class SftpExtensions {
    public static POSIX_RENAME = "posix-rename@openssh.com"; // "1"
    public static STATVFS = "statvfs@openssh.com"; // "2"
    public static FSTATVFS = "fstatvfs@openssh.com"; // "2"
    public static HARDLINK = "hardlink@openssh.com"; // "1"
    public static FSYNC = "fsync@openssh.com"; // "1"
    public static NEWLINE = "newline@sftp.ws"; // "\n"
    public static CHARSET = "charset@sftp.ws"; // "utf-8"

    private static _constructor = (() => {
        for (var name in SftpExtensions) {
            if (SftpExtensions.hasOwnProperty(name)) {
                SftpExtensions["_" + SftpExtensions[name]] = true;
            }
        }
    })();

    static isKnown(name: string): boolean {
        return SftpExtensions.hasOwnProperty("_" + name);
    }
}

export class SftpStatus {


    static write(response: SftpPacketWriter, code: SftpStatusCode, message: string) {
        response.type = SftpPacketType.STATUS;
        response.start();

        response.writeInt32(code);
        response.writeString(message);
        response.writeInt32(0);
    }

    static writeSuccess(response: SftpPacketWriter) {
        this.write(response, SftpStatusCode.OK, "OK");
    }
}

export class SftpOptions {
    encoding: string;
    handle: NodeBuffer;
    flags: string;
    mode: number;
    start: number;
    end: number;
    autoClose: boolean;
}

export class SftpItem implements IItem {
    filename: string;
    longname: string;
    stats: SftpAttributes;

    constructor(request: SftpPacketReader)
    constructor(filename: string, stats?: IStats)
    constructor(arg: any, stats?: IStats) {
        if (typeof arg === 'object') {
            var request = <SftpPacketReader>arg;
            this.filename = request.readString();
            this.longname = request.readString();
            this.stats = new SftpAttributes(request);
        } else {
            var filename = <string>arg;
            this.filename = filename;
            this.longname = filename;
            if (typeof stats === 'object') {
                var attr = new SftpAttributes();
                attr.from(stats);
                this.stats = attr;
                this.longname = attr.toString() + " " + filename;
            }
        }
    }

    write(response: SftpPacketWriter): void {
        response.writeString(this.filename);
        response.writeString(this.longname);
        if (typeof this.stats === "object")
            this.stats.write(response);
        else
            response.writeInt32(0);
    }
}

interface IStatsExt extends IStats {
    nlink?: number;
}

const enum SftpAttributeFlags {
    SIZE         = 0x00000001,
    UIDGID       = 0x00000002,
    PERMISSIONS  = 0x00000004,
    ACMODTIME    = 0x00000008,
    BASIC        = 0x0000000F,
    EXTENDED     = 0x80000000,
}

export class SftpAttributes implements IStats {

    //uint32   flags
    //uint64   size           present only if flag SSH_FILEXFER_ATTR_SIZE
    //uint32   uid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    //uint32   gid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    //uint32   permissions    present only if flag SSH_FILEXFER_ATTR_PERMISSIONS
    //uint32   atime          present only if flag SSH_FILEXFER_ATTR_ACMODTIME
    //uint32   mtime          present only if flag SSH_FILEXFER_ATTR_ACMODTIME
    //uint32   extended_count present only if flag SSH_FILEXFER_ATTR_EXTENDED
    //string   extended_type
    //string   extended_data
    //...      more extended data(extended_type - extended_data pairs),
    //so that number of pairs equals extended_count

    flags: SftpAttributeFlags;
    size: number;
    uid: number;
    gid: number;
    mode: number;
    atime: Date;
    mtime: Date;
    nlink: number;

    isDirectory(): boolean {
        return (this.mode & FileType.ALL) == FileType.DIRECTORY;
    }

    isFile(): boolean {
        return (this.mode & FileType.ALL) == FileType.REGULAR_FILE;
    }

    isSymbolicLink(): boolean {
        return (this.mode & FileType.ALL) == FileType.SYMLINK;
    }

    constructor(request?: SftpPacketReader) {
        if (typeof request === 'undefined') {
            this.flags = 0;
            return;
        }

        var flags = this.flags = request.readUint32();

        if (flags & SftpAttributeFlags.SIZE) {
            this.size = request.readInt64();
        }

        if (flags & SftpAttributeFlags.UIDGID) {
            this.uid = request.readInt32();
            this.gid = request.readInt32();
        }

        if (flags & SftpAttributeFlags.PERMISSIONS) {
            this.mode = request.readUint32();
        }

        if (flags & SftpAttributeFlags.ACMODTIME) {
            this.atime = new Date(1000 * request.readUint32());
            this.mtime = new Date(1000 * request.readUint32());
        }

        if (flags & SftpAttributeFlags.EXTENDED) {
            this.flags &= ~SftpAttributeFlags.EXTENDED;
            this.size = request.readInt64();
            for (var i = 0; i < this.size; i++) {
                request.skipString();
                request.skipString();
            }
        }
    }

    write(response: SftpPacketWriter): void {
        var flags = this.flags;
        response.writeInt32(flags);

        if (flags & SftpAttributeFlags.SIZE) {
            response.writeInt64(this.size);
        }

        if (flags & SftpAttributeFlags.UIDGID) {
            response.writeInt32(this.uid);
            response.writeInt32(this.gid);
        }

        if (flags & SftpAttributeFlags.PERMISSIONS) {
            response.writeInt32(this.mode);
        }

        if (flags & SftpAttributeFlags.ACMODTIME) {
            response.writeInt32(this.atime.getTime() / 1000);
            response.writeInt32(this.mtime.getTime() / 1000);
        }

        if (flags & SftpAttributeFlags.EXTENDED) {
            response.writeInt32(0);
        }
    }

    from(stats: IStatsExt): void {
        if (stats == null || typeof stats === 'undefined') {
            this.flags = 0;
        } else {
            var flags = 0;

            if (typeof stats.size !== 'undefined') {
                flags |= SftpAttributeFlags.SIZE;
                this.size = stats.size | 0;
            }

            if (typeof stats.uid !== 'undefined' || typeof stats.gid !== 'undefined') {
                flags |= SftpAttributeFlags.UIDGID;
                this.uid = stats.uid | 0;
                this.gid = stats.gid | 0;
            }

            if (typeof stats.mode !== 'undefined') {
                flags |= SftpAttributeFlags.PERMISSIONS;
                this.mode = stats.mode | 0;
            }

            if (typeof stats.atime !== 'undefined' || typeof stats.mtime !== 'undefined') {
                flags |= SftpAttributeFlags.ACMODTIME;
                this.atime = stats.atime; //TODO: make sure its Date
                this.mtime = stats.mtime; //TODO: make sure its Date
            }

            if (typeof stats.nlink !== 'undefined') {
                this.nlink = stats.nlink;
            }

            this.flags = flags;
        }
    }

    toString(): string {
        var attrs = this.mode;

        var perms;
        switch (attrs & FileType.ALL) {
            case FileType.CHARACTER_DEVICE:
                perms = "c";
                break;
            case FileType.DIRECTORY:
                perms = "d";
                break;
            case FileType.BLOCK_DEVICE:
                perms = "b";
                break;
            case FileType.REGULAR_FILE:
                perms = "-";
                break;
            case FileType.SYMLINK:
                perms = "l";
                break;
            case FileType.SOCKET:
                perms = "s";
                break;
            case FileType.FIFO:
                perms = "p";
                break;
            default:
                perms = "-";
                break;
        }

        attrs &= 0x1FF;

        for (var j = 0; j < 3; j++) {
            var mask = (attrs >> ((2 - j) * 3)) & 0x7;
            perms += (mask & 4) ? "r" : "-";
            perms += (mask & 2) ? "w" : "-";
            perms += (mask & 1) ? "x" : "-";
        }

        var len = this.size.toString();
        if (len.length < 9)
            len = "         ".slice(len.length - 9) + len;
        else
            len = " " + len;

        var modified = this.mtime;
        var diff = (new Date().getTime() - modified.getTime()) / (3600 * 24);
        var date = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][modified.getUTCMonth()];
        var day = modified.getUTCDate();
        date += ((day <= 9) ? "  " : " ") + day;

        if (diff < -30 || diff > 180)
            date += "  " + modified.getUTCFullYear();
        else
            date += " " + ("0" + modified.getUTCHours()).slice(-2) + ":" + ("0" + modified.getUTCMinutes()).slice(-2);

        var nlink = (typeof this.nlink === 'undefined') ? 1 : this.nlink;

        return perms + " " + nlink + " user group " + len + " " + date;
    }

}

