// See README.md for Usage

// Get dependencies
var net = require("net");
var fs = require("fs");
var EventEmitter = require("events").EventEmitter;
var moira = require('moira');
var findPort = require('find-port');

function Request(client, args) {

    var self = this;
    var intervalId = false;

    moira.getIP(function(error, ip, service) {
        if (error) {
            // Send error message
            self.emit("dlerror", pack, error);
        }
        else {
            this.externalIP = ip;
        }
    });

    this.finished = false;
    this.client = client;
    this.args = args;
    this.pack_info = {};

    if(typeof this.args.progressInterval == "undefined"){
        this.args.progressInterval = 1;
    }
    if(typeof this.args.resume == "undefined"){
        this.args.resume = true;
    }


    //Start handler
    this.once("start", function () {
        //Request
        this.client.say(this.args.nick, "XDCC SEND " + this.args.pack);
        this.client.ctcp(this.args.nick,"privmsg","XDCC SEND " + this.args.pack);
        // Listen for data from the XDCC bot
        this.client.on("ctcp-privmsg", dcc_download_handler);


        this.once("cancel", function () {
            if (this.finished) {
                return;
            }

            // Cancel the pack
            this.client.say(this.args.nick, "XDCC CANCEL");
            killrequest();
        });

        this.on("kill", function () {
            killrequest()
        });
    });


    function dcc_download_handler(sender, target, message) {

        if (self.finished) {
            return;
        }

        //handle DCC massages
        if (sender == self.args.nick && target == self.client.nick && message.substr(0, 4) == "DCC ") {


            // Split the string into an array
            // The String format is as follows:
            // DCC {command} ("|'){filename}("|') {ip} {port}( {filesize} {Passive Firewall Token})
            var parser = /DCC (\w+) "?'?(.+?)'?"? (\d+) (\d+) ?(\d+) ?(\w+)?/;
            var params = message.match(parser);

            if(params != null){
                // Function to convert Integer to IP address
                function int_to_IP(n) {
                    var octets = [];

                    octets.unshift(n & 255);
                    octets.unshift((n >> 8) & 255);
                    octets.unshift((n >> 16) & 255);
                    octets.unshift((n >> 24) & 255);

                    return octets.join(".");
                }

                switch (params[1]) {
                    //Got DCC SEND message
                    case "SEND":
                        self.pack_info.command = params[1];
                        self.pack_info.filename = params[2];
                        self.pack_info.ip = int_to_IP(parseInt(params[3], 10));
                        self.pack_info.port = parseInt(params[4], 10);
                        self.pack_info.filesize = parseInt(params[5], 10);
                        self.pack_info.token = params[6];
                        self.pack_info.resumepos = 0;

                        // Get the download location
                        self.pack_info.location = self.args.path + (self.args.path.substr(-1, 1) == "/" ? "" : "/")
                            + self.pack_info.filename;

                        // Check for file existence
                        fs.stat(self.pack_info.location + ".part", function (err, stats) {

                            // File exists
                            if (!err && stats.isFile()) {
                                if (self.args.resume) {
                                    // Resume download
                                    self.client.ctcp(self.args.nick, "privmsg", "DCC RESUME " + self.pack_info.filename + " "
                                                                                    + self.pack_info.port + " " + stats.size);
                                    self.pack_info.resumepos = stats.size;
                                } else {
                                    // Dont resume download delete .part file and start download
                                    fs.unlink(self.pack_info.location + ".part", function (err) {
                                        if (err) throw err;
                                        download(self.pack_info);
                                    });
                                }
                            } else {
                                // File dont exists start download
                                download(self.pack_info);
                            }
                        });
                        break;
                    // Got DCC ACCEPT message (bot accepts the resume command)
                    case "ACCEPT":
                        // Check accept command params
                        if (self.pack_info.filename == params[2] &&
                            self.pack_info.port == parseInt(params[3], 10) &&
                            self.pack_info.resumepos == parseInt(params[4], 10)) {

                            // Download the file
                            self.pack_info.command = params[1];
                            download(self.pack_info);

                        }
                        break;
                }
            }

        }
    }

    // kill this request dont react on further messages
    function killrequest() {
        self.removeAllListeners();
        self.client.removeListener("ctcp-privmsg", dcc_download_handler);
        self.finished = true;
        self.pack_info = {};
        if(self.intervalId){
            clearInterval(self.intervalId);
            intervalId = false;
        }
    }

    function handleTCPDownload(conn, pack, stream) {
        var send_buffer = new Buffer(4);
        var received = pack.resumepos;
        var ack = pack.resumepos;
        intervalId = setInterval(function(){
            self.emit("progress", pack, received);
        },self.args.progressInterval*1000);

            // Callback for data
        conn.on("data", function (data) {
            received += data.length;

            //support for large files
            ack += data.length;
            while (ack > 0xFFFFFFFF) {
                ack -= 0xFFFFFFFF;
            }

            send_buffer.writeUInt32BE(ack, 0);
            conn.write(send_buffer);

            stream.write(data);
        });

        // Callback for completion
        conn.on("end", function () {
            // End the transfer

            // Close writestream
            stream.end();

            // Connection closed
            if (received == pack.filesize) {// Download complete
                fs.rename(pack.location + ".part", pack.location);
                self.emit("complete", pack);
            } else if (received != pack.filesize && !self.finished) {// Download incomplete
                self.emit("dlerror", pack, "Server unexpected closed connection");
            } else if (received != pack.filesize && self.finished) {// Download abborted
                self.emit("dlerror", pack, "Server closed connection, download canceled");
            }

            killrequest();
            conn.destroy();
        });

        // Add error handler
        conn.on("error", function (error) {
            // Close writestream
            stream.end();

            // Send error message
            self.emit("dlerror", pack, error);
            // Destroy the connection
            conn.destroy();

            killrequest();
        });
    }

    function download(pack) {
        if (self.finished) return;

        // Write stream to store data
        var stream = fs.createWriteStream(pack.location + ".part", {flags: 'a'});

        stream.on("open", function () {

            function dot2num(dot)
            {
                var d = dot.split('.');
                return ((((((+d[0])*256)+(+d[1]))*256)+(+d[2]))*256)+(+d[3]);
            }

            var conn;
            // Open connection to the bot
            if (pack.port > 0)
            {
                conn = net.connect(pack.port, pack.ip, function () {
                    self.emit("connect", pack);
                    handleTCPDownload(conn, pack, stream);
                });
            } else {
                //If port == 0 DCC sender is requesting us to receive an incoming connection
                pack.inport = 5005;
                server = net.createServer();
                // scan explicitly
                findPort([5005,5015], function(ports) {
                    if (ports[0] === undefined) {
                        stream.end();

                        // Send error message
                        self.emit("dlerror", pack, {error: 'Unable to get an open port'});
                        // Destroy the connection
                        conn.destroy();

                        killrequest();
                    } else {
                        pack.inport = ports[0];
                        server.listen(pack.inport);
                    }
                });

                server.on('error', function (e) {
                    if (e.code == 'EADDRINUSE') {
                        //Address in use, retrying...
                        setTimeout(function () {
                            server.close();
                            server.listen(PORT, HOST);
                        }, 1000);
                    } else {
						self.emit("dlerror", pack, e);
                    }
                });

                server.on('listening',function(sock) {
                    //Once port is open send details to DCC Sender along with token.
                    console.log('Sending:' + "DCC SEND " + pack.filename + " "
                        + dot2num(externalIP) + " " + pack.port + " "  + pack.filesize + " " + pack.token);
                    self.client.ctcp(self.args.nick, "privmsg", "DCC SEND \"" + pack.filename + "\" "
                        + dot2num(externalIP) + " " + pack.inport + " " + pack.filesize + " " + pack.token);
                });

                server.on('connection', function(client) {
                    self.emit("connect", pack);
                    conn = client;
                    handleTCPDownload(conn, pack, stream);
                });
            }
        });
        stream.on("error", function (error) {
            // Close writestream
            stream.end();

            self.emit("dlerror", pack, error);

            killrequest();
        });
    }

    return(this);
}

Request.prototype = Object.create(EventEmitter.prototype);


exports.Request = Request;