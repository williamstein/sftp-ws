import packet = require("./sftp-packet");
import misc = require("./sftp-misc");
import enums = require("./sftp-enums");
import api = require("./fs-api");
import plus = require("./fs-plus");
import fsmisc = require("./fs-misc");
import channel = require("./channel");
import util = require("./util");

import IStats = api.IStats;
import IItem = api.IItem;
import RenameFlags = api.RenameFlags;
import IFilesystem = api.IFilesystem;
import FilesystemPlus = plus.FilesystemPlus;
import Task = plus.Task;
import IChannel = channel.IChannel;
import ILogWriter = util.ILogWriter;
import LogHelper = util.LogHelper;
import LogLevel = util.LogLevel;
import SftpPacket = packet.SftpPacket;
import SftpPacketWriter = packet.SftpPacketWriter;
import SftpPacketReader = packet.SftpPacketReader;
import SftpPacketType = enums.SftpPacketType;
import SftpStatusCode = enums.SftpStatusCode;
import SftpFlags = misc.SftpFlags;
import SftpStatus = misc.SftpStatus;
import SftpAttributes = misc.SftpAttributes;
import SftpExtensions = misc.SftpExtensions;
import Path = fsmisc.Path;

interface SftpRequest {
    callback: Function;
    responseParser: (reply: SftpPacket, callback: Function) => void;
    info: SftpCommandInfo;
}

interface SftpResponse extends SftpPacketReader {
    info: SftpCommandInfo;
}

interface SftpCommandInfo extends Object {
    command: string;
    path?: string;
    oldPath?: string;
    newPath?: string;
    targetPath?: string;
    linkPath?: string;
    handle?: any;
    fromHandle?: any;
    toHandle?: any;
}

class SftpItem implements IItem {
    filename: string;
    longname: string;
    stats: SftpAttributes;
}

class SftpHandle {
    _handle: Buffer;
    _this: SftpClientCore;

    constructor(handle: Buffer, owner: SftpClientCore) {
        this._handle = handle;
        this._this = owner;
    }

    toString(): string {
        var value = "0x";
        for (var i = 0; i < this._handle.length; i++) {
            var b = this._handle[i];
            var c = b.toString(16);
            if (b < 16) value += "0";
            value += c;
        }
        return value;
    }
}

class SftpFeature {
    static HARDLINK = "LINK";
    static POSIX_RENAME = "POSIX_RENAME";
    static COPY_FILE = "COPY_FILE";
    static COPY_DATA = "COPY_DATA";
    static CHECK_FILE_HANDLE = "CHECK_FILE_HANDLE";
    static CHECK_FILE_NAME = "CHECK_FILE_NAME";
}

class SftpClientCore implements IFilesystem {
    private static _nextSessionId = 1;
    private _sessionId: number;

    private _host: IChannel
    private _id: number;
    private _requests: SftpRequest[];
    private _ready: boolean;
    private _extensions: Object;
    private _features: Object;

    private _log: ILogWriter;
    private _debug: boolean;
    private _trace: boolean;

    private _maxReadBlockLength: number;
    private _maxWriteBlockLength: number;

    private _bytesReceived: number;
    private _bytesSent: number;

    private getRequest(type: SftpPacketType|string): SftpPacketWriter {
        var request = new SftpPacketWriter(this._maxWriteBlockLength + 1024);

        request.type = type;
        request.id = this._id;

        if (type == SftpPacketType.INIT) {
            if (this._id != null)
                throw new Error("Already initialized");
            this._id = 1;
        } else {
            this._id = (this._id + 1) & 0xFFFFFFFF;
        }

        request.start();
        return request;
    }

    private writeStats(packet: SftpPacketWriter, attrs?: IStats): void {
        var pattrs = new SftpAttributes();
        pattrs.from(attrs);
        pattrs.write(packet);
    }

    constructor() {
        this._sessionId = SftpClientCore._nextSessionId++;
        this._host = null;
        this._id = null;
        this._ready = false;
        this._requests = [];
        this._extensions = {};
        this._features = {};

        this._maxWriteBlockLength = 32 * 1024;
        this._maxReadBlockLength = 256 * 1024;

        this._bytesReceived = 0;
        this._bytesSent = 0;
    }

    getChannelStats(): {} {
        return {
            bytesReceived: this._bytesReceived,
            bytesSent: this._bytesSent,
        };
    }

    private execute(request: SftpPacketWriter, callback: Function, responseParser: (response: SftpResponse, callback: Function) => void, info: SftpCommandInfo): void {
        if (!this._host) {
            process.nextTick(() => {
                var error = this.createError(SftpStatusCode.NO_CONNECTION, "Not connected", info);
                callback(error);
            });
            return;
        }

        if (typeof this._requests[request.id] !== 'undefined')
            throw new Error("Duplicate request");

        var packet = request.finish();

        if (this._debug) {
            // logging
            var meta = {};
            meta["session"] = this._sessionId;
            if (request.type != SftpPacketType.INIT) meta["req"] = request.id;
            meta["type"] = SftpPacket.toString(request.type);
            meta["length"] = packet.length;
            if (this._trace) meta["raw"] = packet;

            if (request.type == SftpPacketType.INIT) {
                this._log.debug(meta, "[%d] - Sending initialization request", this._sessionId);
            } else {
                this._log.debug(meta, "[%d] #%d - Sending request", this._sessionId, request.id);
            }
        }

        this._host.send(packet);
        this._bytesSent += packet.length;

        this._requests[request.id] = { callback: callback, responseParser: responseParser, info: info };
    }

    _init(host: IChannel, log: ILogWriter, callback: (err: Error) => any): void {
        if (this._host) throw new Error("Already bound");

        this._host = host;
        this._extensions = {};

        this._log = log;

        // determine the log level now to speed up logging later
        var level = LogHelper.getLevel(log);
        this._debug = level <= LogLevel.DEBUG;
        this._trace = level <= LogLevel.TRACE;

        var request = this.getRequest(SftpPacketType.INIT);

        request.writeInt32(3); // SFTPv3

        var info = { command: "init" };

        this.execute(request, callback, (response, cb) => {

            if (response.type != SftpPacketType.VERSION) {
                host.close(3002);
                var error = this.createError(SftpStatusCode.BAD_MESSAGE, "Unexpected message", info);
                return callback(new Error("Protocol violation"));
            }

            var version = response.readInt32();
            if (version != 3) {
                host.close(3002);
                var error = this.createError(SftpStatusCode.BAD_MESSAGE, "Unexpected protocol version", info);
                return callback(error);
            }

            while ((response.length - response.position) >= 4) {
                var extensionName = response.readString();
                var value = SftpExtensions.read(response, extensionName);

                if (extensionName.indexOf("@openssh.com") === (extensionName.length - 12)) {
                    // OpenSSH extensions may occur multiple times
                    var val = <string>this._extensions[extensionName];
                    if (typeof val === "undefined") {
                        val = value;
                    } else {
                        val += "," + value;
                    }
                }

                this._extensions[extensionName] = value;
            }

            this._log.debug(this._extensions, "[%d] - Server extensions", this._sessionId);

            if (SftpExtensions.contains(this._extensions[SftpExtensions.HARDLINK], "1")) {
                this._features[SftpFeature.HARDLINK] = SftpExtensions.HARDLINK;
            }

            if (SftpExtensions.contains(this._extensions[SftpExtensions.POSIX_RENAME], "1")) {
                this._features[SftpFeature.POSIX_RENAME] = SftpExtensions.POSIX_RENAME;
            }

// #if FULL
            this._features[SftpFeature.CHECK_FILE_HANDLE] = SftpExtensions.CHECK_FILE_HANDLE;
            this._features[SftpFeature.COPY_DATA] = SftpExtensions.COPY_DATA;
// #endif

            this._ready = true;
            callback(null);
        }, info);
    }

    _process(packet: Buffer): void {
        this._bytesReceived += packet.length;
        var response = <SftpResponse>new SftpPacketReader(packet);

        if (this._debug) {
            var meta = {};
            meta["session"] = this._sessionId;
            if (response.type != SftpPacketType.VERSION) meta["req"] = response.id;
            meta["type"] = SftpPacket.toString(response.type);
            meta["length"] = response.length;
            if (this._trace) meta["raw"] = response.buffer;

            if (response.type == SftpPacketType.VERSION) {
                this._log.debug(meta, "[%d] - Received version response", this._sessionId);
            } else {
                this._log.debug(meta, "[%d] #%d - Received response", this._sessionId, response.id);
            }
        }

        var request = this._requests[response.id];

        if (typeof request === 'undefined')
            throw new Error("Unknown response ID");

        delete this._requests[response.id];

        response.info = request.info;

        request.responseParser.call(this, response, request.callback);
    }

    end(): void {
        var host = this._host;
        if (host) {
            this._host = null;
            host.close();
        }
        this.failRequests(SftpStatusCode.CONNECTION_LOST, "Connection closed");
    }

    private failRequests(code: SftpStatusCode, message: string): void {
        var requests = this._requests;
        this._requests = [];

        requests.forEach(request => {
            var error = this.createError(code, message, request.info);
            request.callback(error);
        });
    }

    open(path: string, flags: string, attrs: IStats, callback: (err: Error, handle: any) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.OPEN);

        request.writeString(path);
        request.writeInt32(SftpFlags.toNumber(flags));
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseHandle, { command: "open", path: path });
    }

    close(handle: any, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.CLOSE);

        request.writeData(h);

        this.execute(request, callback, this.parseStatus, { command: "close", handle: handle });
    }

    read(handle: any, buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error, buffer: Buffer, bytesRead: number) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);
        if (buffer) this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        // make sure the length is within reasonable limits
        if (length > this._maxReadBlockLength)
            length = this._maxReadBlockLength;

        var request = this.getRequest(SftpPacketType.READ);

        request.writeData(h);
        request.writeInt64(position);
        request.writeInt32(length);

        this.execute(request, callback, (response, cb) => this.parseData(response, callback, 0, h, buffer, offset, length, position), { command: "read", handle: handle });
    }

    write(handle: any, buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        if (length > this._maxWriteBlockLength)
            throw new Error("Length exceeds maximum allowed data block length");

        var request = this.getRequest(SftpPacketType.WRITE);

        request.writeData(h);
        request.writeInt64(position);
        request.writeData(buffer, offset, offset + length);

        this.execute(request, callback, this.parseStatus, { command: "write", handle: handle });
    }

    lstat(path: string, callback: (err: Error, attrs: IStats) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.LSTAT, [path], callback, this.parseAttribs, { command: "lstat", path: path });
    }

    fstat(handle: any, callback: (err: Error, attrs: IStats) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSTAT);

        request.writeData(h);

        this.execute(request, callback, this.parseAttribs, { command: "fstat", handle: handle });
    }

    setstat(path: string, attrs: IStats, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.SETSTAT);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "setstat", path: path });
    }

    fsetstat(handle: any, attrs: IStats, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSETSTAT);

        request.writeData(h);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "fsetstat", handle: handle });
    }

    opendir(path: string, callback: (err: Error, handle: any) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.OPENDIR, [path], callback, this.parseHandle, { command: "opendir", path: path });
    }

    readdir(handle: any, callback: (err: Error, items: IItem[] | boolean) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.READDIR);

        request.writeData(h);

        this.execute(request, callback, this.parseItems, { command: "readdir", handle: handle });
    }

    unlink(path: string, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.REMOVE, [path], callback, this.parseStatus, { command: "unlink", path: path });
    }

    mkdir(path: string, attrs: IStats, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.MKDIR);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "mkdir", path: path });
    }

    rmdir(path: string, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.RMDIR, [path], callback, this.parseStatus, { command: "rmdir", path: path });
    }

    realpath(path: string, callback: (err: Error, resolvedPath: string) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.REALPATH, [path], callback, this.parsePath, { command: "realpath", path: path });
    }

    stat(path: string, callback: (err: Error, attrs: IStats) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.STAT, [path], callback, this.parseAttribs, { command: "stat", path: path });
    }

    rename(oldPath: string, newPath: string, flags: RenameFlags, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        oldPath = this.checkPath(oldPath, 'oldPath');
        newPath = this.checkPath(newPath, 'newPath');

        var command;
        var info = { command: "rename", oldPath: oldPath, newPath: newPath, flags: flags };
        switch (flags) {
            case RenameFlags.OVERWRITE:
                command = SftpFeature.POSIX_RENAME;
                break;
            case 0 as RenameFlags:
                command = SftpPacketType.RENAME;
                break;
            default:
                process.nextTick(() => callback(this.createError(SftpStatusCode.OP_UNSUPPORTED, "Unsupported rename flags", info)));
                break;
        }

        this.command(command, [oldPath, newPath], callback, this.parseStatus, info);
    }

    readlink(path: string, callback: (err: Error, linkString: string) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.READLINK, [path], callback, this.parsePath, { command: "readlink", path: path });
    }

    symlink(targetPath: string, linkPath: string, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        targetPath = this.checkPath(targetPath, 'targetPath');
        linkPath = this.checkPath(linkPath, 'linkPath');

        this.command(SftpPacketType.SYMLINK, [targetPath, linkPath], callback, this.parseStatus, { command: "symlink", targetPath: targetPath, linkPath: linkPath });
    }

    link(oldPath: string, newPath: string, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        oldPath = this.checkPath(oldPath, 'oldPath');
        newPath = this.checkPath(newPath, 'newPath');

        this.command(SftpFeature.HARDLINK, [oldPath, newPath], callback, this.parseStatus, { command: "link", oldPath: oldPath, newPath: newPath });
    }

// #if FULL
    fcopy(fromHandle: any, fromPosition: number, length: number, toHandle: any, toPosition: number, callback: (err: Error) => any): void {
        this.checkCallback(callback);
        var fh = this.toHandle(fromHandle);
        var th = this.toHandle(toHandle);
        this.checkPosition(fromPosition);
        this.checkPosition(toPosition);

        var request = this.getRequest(SftpExtensions.COPY_DATA);

        request.writeData(fh);
        request.writeInt64(fromPosition);
        request.writeInt64(length);
        request.writeData(th);
        request.writeInt64(toPosition);

        this.execute(request, callback, this.parseStatus, { command: "fcopy", fromHandle: fromHandle, toHandle: toHandle });
    }

    fhash(handle: any, alg: string, position: number, length: number, blockSize: number, callback: (err: Error, hashes: Buffer, alg: string) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);
        this.checkPosition(position);

        //TODO: reject requests with oversize response

        var request = this.getRequest(SftpExtensions.CHECK_FILE_HANDLE);

        request.writeData(h);
        request.writeString(alg);
        request.writeInt64(position);
        request.writeInt64(length);
        request.writeInt32(blockSize);

        this.execute(request, callback, this.parseHash, { command: "fhash", handle: handle });
    }
// #endif

    private checkCallback(callback: any): void {
        if (typeof callback !== "function") throw new Error("Callback must be a function");
    }

    private toHandle(handle: { _handle: Buffer; _this: SftpClientCore }): Buffer {
        if (!handle) {
            throw new Error("Missing handle");
        } else if (typeof handle === 'object') {
            if (SftpPacket.isBuffer(handle._handle) && handle._this == this)
                return handle._handle;
        }

        throw new Error("Invalid handle");
    }

    private checkBuffer(buffer: Buffer, offset: number, length: number): void {
        if (!SftpPacket.isBuffer(buffer))
            throw new Error("Invalid buffer");

        if (typeof offset !== 'number' || offset < 0)
            throw new Error("Invalid offset");

        if (typeof length !== 'number' || length < 0)
            throw new Error("Invalid length");

        if ((offset + length) > buffer.length)
            throw new Error("Offset or length is out of bands");
    }

    private checkPath(path: string, name: string): string {
        path = Path.check(path, name);
        if (path[0] === '~') {
            if (path[1] === '/') {
                path = "." + path.substr(1);
            } else if (path.length == 1) {
                path = ".";
            }
        }
        return path;
    }

    private checkPosition(position: number): void {
        if (typeof position !== 'number' || position < 0 || position > 0x7FFFFFFFFFFFFFFF)
            throw new Error("Invalid position");
    }

    private command(command: SftpPacketType | string, args: string[], callback: Function, responseParser: (response: SftpResponse, callback: Function) => void, info: SftpCommandInfo): void {
        if (typeof command !== "number") command = this._features[command];

        if (!command) {
            process.nextTick(() => callback(this.createError(SftpStatusCode.OP_UNSUPPORTED, "Operation not supported", info)));
            return;
        }

        var request = this.getRequest(command);

        for (var i = 0; i < args.length; i++) {
            request.writeString(args[i]);
        }

        this.execute(request, callback, responseParser, info);
    }

    private readStatus(response: SftpResponse): Error {
        var nativeCode = response.readInt32();
        var message = response.readString();
        if (nativeCode == SftpStatusCode.OK)
            return null;

        var info = response.info;
        return this.createError(nativeCode, message, info);
    }

    private readItem(response: SftpResponse): IItem {
        var item = new SftpItem();
        item.filename = response.readString();
        item.longname = response.readString();
        item.stats = new SftpAttributes(response);
        return item;
    }

    private createError(nativeCode: number, message: string, info: SftpCommandInfo) {
        var code;
        var errno;
        switch (nativeCode) {
            case SftpStatusCode.EOF:
                code = "EOF";
                errno = 1;
                break;
            case SftpStatusCode.NO_SUCH_FILE:
                code = "ENOENT";
                errno = 34;
                break;
            case SftpStatusCode.PERMISSION_DENIED:
                code = "EACCES";
                errno = 3;
                break;
            case SftpStatusCode.OK:
            case SftpStatusCode.FAILURE:
            case SftpStatusCode.BAD_MESSAGE:
                code = "EFAILURE";
                errno = -2;
                break;
            case SftpStatusCode.NO_CONNECTION:
                code = "ENOTCONN";
                errno = 31;
                break;
            case SftpStatusCode.CONNECTION_LOST:
                code = "ESHUTDOWN";
                errno = 46;
                break;
            case SftpStatusCode.OP_UNSUPPORTED:
                code = "ENOSYS";
                errno = 35;
                break;
            case SftpStatusCode.BAD_MESSAGE:
                code = "ESHUTDOWN";
                errno = 46;
                break;
            default:
                code = "UNKNOWN";
                errno = -1;
                break;
        }

        var command = info.command;
        var arg = info.path || info.handle;
        if (typeof arg === "string")
            arg = "'" + arg + "'";
        else if (arg)
            arg = new String(arg);
        else
            arg = "";

        var error = new Error(code + ", " + command + " " + arg);
        error['errno'] = errno;
        error['code'] = code;

        for (var name in info) {
            if (name == "command") continue;
            if (info.hasOwnProperty(name)) error[name] = info[name];
        }

        error['nativeCode'] = nativeCode;
        error['description'] = message;
        return error;
    }

    private checkResponse(response: SftpResponse, expectedType: number, callback: Function): boolean {
        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                callback(error);
                return false;
            }
        }

        if (response.type != expectedType)
            throw new Error("Unexpected packet received");

        return true;
    }

    private parseStatus(response: SftpResponse, callback: (err: Error) => any): void {
        if (!this.checkResponse(response, SftpPacketType.STATUS, callback))
            return;

        callback(null);
    }

    private parseAttribs(response: SftpResponse, callback: (err: Error, attrs: IStats) => any): void {
        if (!this.checkResponse(response, SftpPacketType.ATTRS, callback))
            return;

        var attrs = new SftpAttributes(response);
        delete attrs.flags;

        callback(null, attrs);
    }

    private parseHandle(response: SftpResponse, callback: (err: Error, handle: any) => any): void {
        if (!this.checkResponse(response, SftpPacketType.HANDLE, callback))
            return;

        var handle = response.readData(true);

        callback(null, new SftpHandle(handle, this));
    }

    private parsePath(response: SftpResponse, callback: (err: Error, path?: string) => any): void {
        if (!this.checkResponse(response, SftpPacketType.NAME, callback))
            return;

        var count = response.readInt32();
        if (count != 1)
            throw new Error("Invalid response");

        var path = response.readString();

        callback(null, path);
    }

    private parseData(response: SftpResponse, callback: (err: Error, buffer: Buffer, bytesRead: number) => any, retries: number, h: Buffer, buffer: Buffer, offset: number, length: number, position: number): void {
        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['nativeCode'] == SftpStatusCode.EOF) {
                    buffer = buffer ? buffer.slice(offset, 0) : new Buffer(0);
                    callback(null, buffer, 0);
                } else {
                    callback(error, null, 0);
                }
                return;
            }
        }

        var data = response.readData(false);

        if (data.length > length)
            throw new Error("Received too much data");

        length = data.length;
        if (length == 0) {
            // workaround for broken servers such as Globalscape 7.1.x that occasionally send empty data

            if (retries > 4) {
                var error = this.createError(SftpStatusCode.FAILURE, "Unable to read data", response.info);
                error['code'] = "EIO";
                error['errno'] = 55;

                callback(error, null, 0);
                return;
            }

            var request = this.getRequest(SftpPacketType.READ);
            request.writeData(h);
            request.writeInt64(position);
            request.writeInt32(length);

            this.execute(request, callback, (response, cb) => this.parseData(response, callback, retries + 1, h, buffer, offset, length, position), response.info);
            return;
        }

        if (!buffer) {
            buffer = data;
        } else {
            data.copy(buffer, offset, 0, length); //WEB: buffer.set(data, offset);
        }

        callback(null, buffer, length);
    }

    private parseItems(response: SftpResponse, callback: (err: Error, items: IItem[]|boolean) => any): void {

        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['nativeCode'] == SftpStatusCode.EOF)
                    callback(null, false);
                else
                    callback(error, null);
                return;
            }
        }

        if (response.type != SftpPacketType.NAME)
            throw new Error("Unexpected packet received");

        var count = response.readInt32();

        var items: IItem[] = [];
        for (var i = 0; i < count; i++) {
            items[i] = this.readItem(response);
        }

        callback(null, items);
    }

// #if FULL
    private parseHash(response: SftpResponse, callback: (err: Error, hashes: Buffer, alg: string) => any): void {
        if (!this.checkResponse(response, SftpPacketType.EXTENDED_REPLY, callback))
            return;

        var alg = response.readString();
        var hashes = response.readData(false);

        callback(null, hashes, alg);
    }
// #endif

}

export interface ISftpClientEvents<T> {
    on(event: 'ready', listener: () => void): T;
    on(event: 'error', listener: (err: Error) => void): T;
    on(event: 'close', listener: (err: Error) => void): T;
    on(event: string, listener: Function): T;

    once(event: 'ready', listener: () => void): T;
    once(event: 'error', listener: (err: Error) => void): T;
    once(event: 'close', listener: (err: Error) => void): T;
    once(event: string, listener: Function): T;
}

export class SftpClient extends FilesystemPlus {

    private _bound: boolean;

    constructor(local: IFilesystem) {
        var sftp = new SftpClientCore();
        super(sftp, local);
    }

    getChannelStats(): {} {
        return (<SftpClientCore>this._fs).getChannelStats();
    }

    bind(channel: IChannel, options?: any, callback?: (err: Error) => void): Task<void> {
        if (typeof callback === "undefined" && typeof options === "function") {
            callback = options;
            options = null;
        }

        return super._task(callback, callback => this._bind(channel, options, callback));
    }

    protected _bind(channel: IChannel, options: any, callback: (err: Error) => void): void {
        var sftp = <SftpClientCore>this._fs;

        if (this._bound) throw new Error("Already bound");
        this._bound = true;

        var log = LogHelper.toLogWriter(options && options.log);

        sftp._init(channel, log, err => {
            if (err) {
                sftp.end();
                this._bound = false;
                callback(err);
            } else {
                callback(null);
                this.emit('ready');
            }
        });

        channel.on("message", packet => {
            try {
                sftp._process(packet);
            } catch (err) {
                this.emit("error", err);
            }
        });

        channel.on("close", err => {
            sftp.end();
            this._bound = false;

            if (!this.emit("close", err)) {
                // if an error occured and no close handler is available, raise an error
                if (err) this.emit("error", err);
            }
        });
    }

    end(): void {
        var sftp = <SftpClientCore>this._fs;
        sftp.end();
        this.emit("close", null);
    }
}
